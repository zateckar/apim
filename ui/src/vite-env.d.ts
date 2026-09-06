/// <reference types="vite/client" />

// Vite's ambient declarations, which is where `import "./styles.css"` is a legal statement rather
// than a missing module. TypeScript 7 rejects a side-effect import of a file it has no declaration
// for (TS2882) where TypeScript 5 let it pass, so the three stylesheet imports in `main.tsx` need
// this reference to exist. `tsconfig.json` pins `types` to `["bun"]`, so the reference has to be
// written here rather than picked up from `node_modules` by itself.
