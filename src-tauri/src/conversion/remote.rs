//! Bounded fetching of remote images used by DOCX export.
//!
//! The policy is enforced on the address that is actually connected to, not on
//! the URL text: every hop is resolved once, all answers must be allowed, the
//! validated socket addresses are pinned into the HTTP client, proxies and
//! automatic redirects are disabled, and every redirect is re-validated.
use super::{Operation, Result};
use reqwest::blocking::Client;
use std::{
    io::{self, Read},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    sync::Once,
    time::{Duration, Instant},
};
use url::{Host, Url};

const MAX_REDIRECTS: usize = 4;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn fetch_remote_image(op: &Operation, source: &str) -> Result<Vec<u8>> {
    ensure_crypto_provider();
    fetch_with(
        source,
        op.deadline,
        &|| op.check(),
        &SystemResolver,
        &ReqwestTransport,
    )
}

fn ensure_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

trait Resolver {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>>;
}

struct SystemResolver;
impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        (host, port).to_socket_addrs().map(|addrs| addrs.collect())
    }
}

struct Response {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

trait Transport {
    fn get(&self, url: &Url, pinned: &[SocketAddr], timeout: Duration) -> Result<Response>;
}

struct ReqwestTransport;
impl Transport for ReqwestTransport {
    fn get(&self, url: &Url, pinned: &[SocketAddr], timeout: Duration) -> Result<Response> {
        let mut builder = Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            // An environment/system proxy would fetch the address itself and
            // bypass the pinned, validated destination.
            .no_proxy();
        if let Some(Host::Domain(host)) = url.host() {
            builder = builder.resolve_to_addrs(host, pinned);
        }
        let client = builder
            .build()
            .map_err(|e| format!("初始化 Word 网络图片请求失败: {e}"))?;
        let response = client
            .get(url.clone())
            .send()
            .map_err(|e| format!("读取 Word 网络图片失败: {e}"))?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|_| "Word 网络图片重定向目标无效".to_string())
            })
            .transpose()?;
        if !(200..=299).contains(&status) {
            return Ok(Response {
                status,
                location,
                body: Vec::new(),
            });
        }
        let mut body = Vec::new();
        response
            .take(MAX_IMAGE_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|e| e.to_string())?;
        Ok(Response {
            status,
            location,
            body,
        })
    }
}

fn fetch_with(
    source: &str,
    deadline: Instant,
    check: &dyn Fn() -> Result<()>,
    resolver: &dyn Resolver,
    transport: &dyn Transport,
) -> Result<Vec<u8>> {
    let mut url = parse_remote_url(source)?;
    for redirect in 0..=MAX_REDIRECTS {
        check()?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("转换超时（90 秒）".into());
        }
        let pinned = resolve_public(&url, resolver)?;
        let response = transport.get(&url, &pinned, remaining.min(REQUEST_TIMEOUT))?;
        if (300..=399).contains(&response.status) {
            if redirect == MAX_REDIRECTS {
                return Err("Word 网络图片重定向次数过多".into());
            }
            let location = response.location.ok_or("Word 网络图片重定向缺少目标")?;
            let next = url
                .join(&location)
                .map_err(|_| "Word 网络图片重定向目标无效".to_string())?;
            url = parse_remote_url(next.as_str())?;
            continue;
        }
        if !(200..=299).contains(&response.status) {
            return Err(format!("读取 Word 网络图片失败: HTTP {}", response.status));
        }
        if response.body.len() > MAX_IMAGE_BYTES {
            return Err("Word 单张网络图片超过 4 MiB".into());
        }
        return Ok(response.body);
    }
    Err("Word 网络图片重定向次数过多".into())
}

fn parse_remote_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "无效的 Word 网络图片地址".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Word 网络图片只允许 HTTP(S) 地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Word 网络图片不允许包含账号信息".into());
    }
    if url.host().is_none() {
        return Err("Word 网络图片缺少主机名".into());
    }
    Ok(url)
}

fn resolve_public(url: &Url, resolver: &dyn Resolver) -> Result<Vec<SocketAddr>> {
    let port = url.port_or_known_default().ok_or("Word 网络图片缺少端口")?;
    let addresses = match url.host() {
        Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(Host::Domain(host)) => {
            if forbidden_hostname(host) {
                return Err("Word 网络图片不允许访问本机或内部域名".into());
            }
            resolver
                .resolve(host, port)
                .map_err(|e| format!("无法解析 Word 网络图片域名: {e}"))?
        }
        None => return Err("Word 网络图片缺少主机名".into()),
    };
    if addresses.is_empty() {
        return Err("Word 网络图片域名没有可用地址".into());
    }
    let mut pinned = Vec::with_capacity(addresses.len());
    for address in addresses {
        if !allowed_address(address.ip()) {
            return Err(format!("Word 网络图片地址不允许访问: {}", address.ip()));
        }
        pinned.push(address);
    }
    Ok(pinned)
}

fn forbidden_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
}

fn allowed_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => allowed_ipv4(ip),
        IpAddr::V6(ip) => allowed_ipv6(ip),
    }
}

fn allowed_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (b & 0xc0) == 64)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        // 198.18.0.0/15 is a benchmarking range, but fake-IP DNS proxies
        // (common on desktop VPNs) hand it out for every public host. Blocking
        // it would reject legitimate public HTTPS images there. It is not an
        // internal/link-local range, so the internal-target policy is unchanged.
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240)
}

fn allowed_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return allowed_ipv4(mapped);
    }
    let [a, b, ..] = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    // Link-local and unique-local are outside 2000::/3, keep the explicit
    // checks for clarity.
    if (a & 0xffc0) == 0xfe80 || (a & 0xfe00) == 0xfc00 || (a & 0xffc0) == 0xfec0 {
        return false;
    }
    if (a & 0xe000) != 0x2000 {
        return false;
    }
    // 2001::/23 (Teredo, ORCHID, protocol assignments), 2001:db8::/32,
    // 2002::/16 (6to4 embeds IPv4) and 3fff::/20 (documentation).
    if a == 0x2001 && (b < 0x0200 || b == 0x0db8) {
        return false;
    }
    !(a == 0x2002 || (a == 0x3fff && (b & 0xf000) == 0))
}
