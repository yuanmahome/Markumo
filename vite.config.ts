import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

// Bundle only runtime resources, not the PDF viewer UI, examples or Node canvas binaries.
function pdfResources(): Plugin {
  const root=path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const files=new Map<string,string>()
  // Serve the prebuilt Worker unchanged. Vite 5's import-query helper uses document,
  // which cannot run inside a Worker when transforming PDF.js's dynamic imports.
  files.set('/pdfjs/pdf.worker.min.mjs',path.join(root,'build/pdf.worker.min.mjs'))
  for(const directory of ['cmaps','standard_fonts','wasm']) for(const name of fs.readdirSync(path.join(root,directory))) {
    if(!/\.(bcmap|pfb|ttf|wasm|mjs|js)$/.test(name) && !name.startsWith('LICENSE'))continue
    files.set(`/pdfjs/${directory}/${name}`,path.join(root,directory,name))
  }
  return {name:'local-pdf-resources',
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const file=files.get((req.url||'').split('?')[0]);if(!file)return next()
      res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');fs.createReadStream(file).pipe(res)
    })},
    generateBundle(){files.forEach((file,url)=>this.emitFile({type:'asset',fileName:url.slice(1),source:fs.readFileSync(file)}));this.emitFile({type:'asset',fileName:'pdfjs/LICENSE',source:fs.readFileSync(path.join(root,'LICENSE'))})},
  }
}

const noDesktopReload = () => process.env.MARKUMO_DESKTOP_NO_RELOAD === '1'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), pdfResources()],
  optimizeDeps: { entries:['index.html'], include:['mermaid','katex','dompurify'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, '/')
          if (/node_modules\/(@codemirror\/(state|view|commands|search|autocomplete|language)\/|@lezer\/(common|lr|highlight)\/|style-mod\/|crelt\/)/.test(modulePath)) return 'editor-core'
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    hmr: noDesktopReload() ? false : undefined,
    watch: noDesktopReload() ? null : {
      ignored: ['**/src-tauri/**', '**/.markumo-dev/**', '**/.lightedit-dev/**'],
    },
  },
})
