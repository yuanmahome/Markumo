"""Resolve captured native allocation stacks with matching public MS symbols.

The symbolizer runs offline from acceptance measurements, loads symbols only
into its own process, and saves unresolved/export fallbacks explicitly.
"""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import sys

source = Path(sys.argv[1]).resolve()
destination = source.parent / 'native-symbols.json'
result = {'source': str(source), 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'symbolServer': 'https://msdl.microsoft.com/download/symbols', 'available': False}
try:
    report = json.loads(source.read_text(encoding='utf-8'))
    profile = report['samples'][0]['nativeProfile']['profile']
    expected = {((report['fixtures'][name]['bytes'] + 2) // 3) * 4 + 12: name for name in ['img-small-1.png', 'img-small-2.png']}
    candidates = [sample for sample in profile['samples'] if sample['size'] in expected]
    groups = {}
    for sample in candidates:
        key = tuple(sample['stack'])
        row = groups.setdefault(key, {'count': 0, 'actualBytes': 0, 'sampledTotalBytes': 0, 'payloads': {}})
        row['count'] += 1
        row['actualBytes'] += sample['size']
        row['sampledTotalBytes'] += sample['total']
        name = expected[sample['size']]
        row['payloads'][name] = row['payloads'].get(name, 0) + 1
    result.update(candidateCount=len(candidates), formula='ceil(PNG_bytes / 3) * 4 + 12', groups=[])
    debugger = Path('C:/Program Files (x86)/Windows Kits/10/Debuggers/x64')
    directory_handle = os.add_dll_directory(str(debugger))
    library = C.WinDLL(str(debugger / 'dbghelp.dll'), use_last_error=True)
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = W.HANDLE
    handle = kernel.GetCurrentProcess()
    library.SymSetOptions.argtypes = [W.DWORD]
    library.SymSetOptions.restype = W.DWORD
    library.SymSetOptions(0x2 | 0x4 | 0x200 | 0x400 | 0x80000)
    cache = Path(__file__).resolve().parent.parent / 'test-results/p01/symbols'
    cache.mkdir(parents=True, exist_ok=True)
    library.SymInitializeW.argtypes = [W.HANDLE, W.LPCWSTR, W.BOOL]
    library.SymInitializeW.restype = W.BOOL
    if not library.SymInitializeW(handle, f'srv*{cache}*https://msdl.microsoft.com/download/symbols', False):
        raise C.WinError(C.get_last_error())
    library.SymLoadModuleExW.argtypes = [W.HANDLE, W.HANDLE, W.LPCWSTR, W.LPCWSTR, C.c_uint64, W.DWORD, C.c_void_p, W.DWORD]
    library.SymLoadModuleExW.restype = C.c_uint64
    module = next(module for module in profile['modules'] if module['name'] == 'msedge.dll.pdb')
    binary = Path(f'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/{report["runtime"]}/msedge.dll')
    base = int(module['baseAddress'], 0)
    result['module'] = module
    result['binary'] = str(binary)
    result['cache'] = str(cache)
    print('Loading matching WebView2 module public symbols:', binary, flush=True)
    if not library.SymLoadModuleExW(handle, None, str(binary), 'msedge.dll', base, module['size'], None, 0):
        raise C.WinError(C.get_last_error())
    class SymbolInfo(C.Structure):
        _fields_ = [('SizeOfStruct', W.ULONG), ('TypeIndex', W.ULONG), ('Reserved', C.c_uint64 * 2), ('Index', W.ULONG), ('Size', W.ULONG), ('ModBase', C.c_uint64), ('Flags', W.ULONG), ('Value', C.c_uint64), ('Address', C.c_uint64), ('Register', W.ULONG), ('Scope', W.ULONG), ('Tag', W.ULONG), ('NameLen', W.ULONG), ('MaxNameLen', W.ULONG), ('Name', C.c_char * 1)]
    library.SymFromAddr.argtypes = [W.HANDLE, C.c_uint64, C.POINTER(C.c_uint64), C.POINTER(SymbolInfo)]
    library.SymFromAddr.restype = W.BOOL
    resolved = {}
    for stack, row in sorted(groups.items(), key=lambda pair: -pair[1]['actualBytes'])[:6]:
        frames = []
        for address in stack:
            value = int(address, 0)
            if not base <= value < base + module['size']:
                continue
            if address not in resolved:
                buffer = C.create_string_buffer(C.sizeof(SymbolInfo) + 4096)
                info = C.cast(buffer, C.POINTER(SymbolInfo))
                info.contents.SizeOfStruct = C.sizeof(SymbolInfo)
                info.contents.MaxNameLen = 4096
                displacement = C.c_uint64()
                if library.SymFromAddr(handle, value, C.byref(displacement), info):
                    name = C.string_at(C.addressof(buffer) + SymbolInfo.Name.offset, info.contents.NameLen).decode('utf-8', errors='replace')
                    resolved[address] = {'address': address, 'moduleOffset': hex(value-base), 'name': name, 'displacement': displacement.value, 'flags': info.contents.Flags, 'exportFallback': bool(info.contents.Flags & 0x200)}
                else:
                    resolved[address] = {'address': address, 'moduleOffset': hex(value-base), 'unresolvedError': C.get_last_error()}
                print(address, resolved[address].get('name', 'unresolved'), flush=True)
            frames.append(resolved[address])
        result['groups'].append({**row, 'frames': frames})
    result['available'] = any(frame.get('name') and not frame.get('exportFallback') for frame in resolved.values())
    library.SymCleanup.argtypes = [W.HANDLE]
    library.SymCleanup(handle)
except Exception as error:
    result['error'] = repr(error)
finally:
    destination.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print('SAVED', destination, 'available=', result['available'], flush=True)
