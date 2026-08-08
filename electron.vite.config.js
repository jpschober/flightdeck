// Build for the three processes, and what each of them needs to survive being
// bundled.
//
//   npm start   dev: main and preload built, renderer from the Vite server
//   npm run build   out/ - what electron-builder then packs
//
// The sources stay CommonJS in the main process and ES modules in the
// renderer, the way they were before the bundler. `commonjsOptions.include`
// is what makes that possible: without it Rollup leaves the `require` calls in
// src/ standing, and the bundle points at files that are not next to it.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig } from 'electron-vite';

// Resolved against this file, not against the working directory a build was
// started from.
const SHELL_DIR = fileURLToPath(new URL('src/main/shell-integration', import.meta.url));

// The shell scripts are read at runtime with `path.join(__dirname, name)`, and
// after bundling `__dirname` is out/main. They are copied there rather than
// inlined as strings, because shell-integration/index.js resolves the
// `# flightdeck:include` directive by file name - and the test runs the same
// function under plain Node, where the sources are still where they are.
function copyShellScripts() {
  return {
    name: 'flightdeck:shell-scripts',
    async buildStart() {
      for (const name of await readdir(SHELL_DIR)) {
        if (name.endsWith('.js')) continue;
        const file = join(SHELL_DIR, name);
        this.addWatchFile(file);
        this.emitFile({ type: 'asset', fileName: name, source: await readFile(file) });
      }
    },
  };
}

// Everything under src/ is CommonJS as far as the main and preload builds are
// concerned; node_modules stays included because a dependency that is not
// externalized may be CommonJS too.
const cjs = { include: [/node_modules/, /src\//] };

export default defineConfig({
  main: {
    plugins: [copyShellScripts()],
    build: {
      externalizeDeps: true,
      lib: { entry: 'src/main/main.js' },
      commonjsOptions: cjs,
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      lib: { entry: 'src/preload.js' },
      commonjsOptions: cjs,
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      // The vendor libraries are bundled in, so none of them has to be found
      // by a relative path into node_modules at runtime.
      commonjsOptions: cjs,
      rollupOptions: { input: 'src/renderer/index.html' },
    },
  },
});
