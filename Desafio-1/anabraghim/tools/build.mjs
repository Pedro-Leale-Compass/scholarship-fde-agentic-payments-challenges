// Gera um bundle ESM por tool em infra/build/tools/<nome>/index.mjs. O
// `aws cloudformation package` zipa cada pasta e envia ao bucket de artefatos.
import { build } from "esbuild"
import { rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const raiz = dirname(fileURLToPath(import.meta.url))
const saida = resolve(raiz, "../infra/build/tools")

const tools = ["listar-catalogo", "registrar-intencao", "realizar-compra"]

await rm(saida, { recursive: true, force: true })

for (const nome of tools) {
    await build({
        entryPoints: [resolve(raiz, "src", `${nome}.ts`)],
        outfile: resolve(saida, nome, "index.mjs"),
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        minify: true,
        sourcemap: false,
        // O AWS SDK vai no bundle: versão fixada pelo package-lock, não pela runtime.
        // O banner dá `require` ao ESM, que algumas dependências do SDK usam.
        banner: {
            js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
        logLevel: "info",
    })
}
