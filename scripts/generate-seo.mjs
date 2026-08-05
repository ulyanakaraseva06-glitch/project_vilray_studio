import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)).replace(/\\scripts$/, '');
const sourcePath = join(root, 'content', 'seo', 'pages.json');
const pages = JSON.parse(await readFile(sourcePath, 'utf8'));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderPage(page) {
  const appUrl = `/app/?preset=${encodeURIComponent(JSON.stringify(page.preset ?? {}))}`;

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(page.title)}</title>
    <meta name="description" content="${escapeHtml(page.description)}" />
    <link rel="canonical" href="${escapeHtml(page.slug)}" />
  </head>
  <body>
    <main class="seo-page">
      <section class="seo-hero">
        <p class="seo-kicker">Посчитай плитку</p>
        <h1>${escapeHtml(page.h1)}</h1>
        <p>Онлайн-сервис помогает быстро выбрать помещение, перейти к редактору и подготовить визуальный расчёт плитки.</p>
        <a href="${escapeHtml(appUrl)}">Открыть редактор</a>
      </section>
    </main>
  </body>
</html>`;
}

for (const page of pages) {
  const targetDir = join(root, 'public', page.slug.replace(/^\/|\/$/g, ''));
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'index.html'), renderPage(page), 'utf8');
}
