import { createDoc, getDocByPath } from "./db";

const docs = [
  {
    path: "CLAUDE.md",
    content: `# Documentación interna

Este vault contiene la documentación de los proyectos de la empresa.

## Estructura
- \`pixel/\`  — docs del proyecto Pixel
- \`gmadme/\` — docs del proyecto G-MadMe

Cada carpeta documenta su repo. Buscá acá antes de pedir contexto.
`,
  },
  {
    path: "pixel/setup.md",
    content: `# Setup de Pixel

Pasos para levantar el entorno local del proyecto Pixel.

1. Clonar el repo.
2. \`bun install\`.
3. Copiar \`.env.example\` a \`.env\`.
4. \`bun run dev\`.
`,
  },
  {
    path: "gmadme/arquitectura.md",
    content: `# Arquitectura de G-MadMe

Resumen de los servicios y cómo se comunican.

Ver también [[pixel/setup]] para el patrón de entorno.
`,
  },
];

for (const d of docs) {
  if (getDocByPath("default", d.path)) {
    console.log(`skip (existe): ${d.path}`);
    continue;
  }
  const doc = createDoc({ vault: "default", path: d.path, content: d.content, author: "seed" });
  console.log(`creado: ${doc.path} (seq=${doc.seq})`);
}
