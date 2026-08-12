import type { ProjectCalculation } from '../calculation/calculateProject';
import { getBoundingBox, segmentLength } from '../project/geometry';
import type { PointMm, TileProject } from '../types/project';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

export function exportProjectPdf(project: TileProject, calculation: ProjectCalculation) {
  const pages = [drawPlanPage(project), ...drawWallPages(project), ...drawCalculationPages(project, calculation)];
  const blob = buildImagePdf(pages.map((page) => page.toDataURL('image/jpeg', 0.92)));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `макет-плитки-${new Date().toISOString().slice(0, 10)}.pdf`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

function createPage(title: string) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH;
  canvas.height = PAGE_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  context.fillStyle = '#5D436F';
  context.font = '700 38px Arial, sans-serif';
  context.fillText(title, 72, 86);
  context.fillStyle = '#777181';
  context.font = '20px Arial, sans-serif';
  context.fillText(`Проект Vilray · ${new Date().toLocaleDateString('ru-RU')}`, 72, 122);
  context.strokeStyle = '#E4DAEB';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(72, 146);
  context.lineTo(PAGE_WIDTH - 72, 146);
  context.stroke();
  return { canvas, context };
}

function drawPlanPage(project: TileProject) {
  const { canvas, context } = createPage('Макет помещений');
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour }];
  const allPoints = areas.flatMap((area) => area.contour);
  const box = getBoundingBox(allPoints);
  const scale = Math.min(950 / Math.max(1, box.width), 980 / Math.max(1, box.height));
  const originX = (PAGE_WIDTH - box.width * scale) / 2 - box.minX * scale;
  const originY = 250 - box.minY * scale;
  const point = (value: PointMm) => ({ x: originX + value.x * scale, y: originY + value.y * scale });

  for (const area of areas) {
    const points = area.contour.map(point);
    context.beginPath();
    points.forEach((value, index) => index ? context.lineTo(value.x, value.y) : context.moveTo(value.x, value.y));
    context.closePath();
    context.fillStyle = '#F7F1FA';
    context.fill();
    context.strokeStyle = '#8A6AAE';
    context.lineWidth = 6;
    context.stroke();
    context.fillStyle = '#5D436F';
    context.font = '600 22px Arial, sans-serif';
    context.fillText(area.name, Math.min(...points.map((item) => item.x)) + 16, Math.min(...points.map((item) => item.y)) + 32);
    area.contour.forEach((start, index) => {
      const end = area.contour[(index + 1) % area.contour.length];
      const a = point(start);
      const b = point(end);
      drawTag(context, `${Math.round(segmentLength(start, end))} мм`, (a.x + b.x) / 2, (a.y + b.y) / 2);
    });
  }

  for (const partition of project.room.partitions ?? []) {
    const a = point(partition.start);
    const b = point(partition.end);
    context.strokeStyle = '#65457E';
    context.lineWidth = Math.max(5, partition.thicknessMm * scale);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }

  for (const object of project.objects) {
    context.fillStyle = 'rgba(104, 72, 130, 0.55)';
    context.fillRect(originX + object.xMm * scale, originY + object.yMm * scale, object.lengthMm * scale, object.widthMm * scale);
    context.fillStyle = '#FFFFFF';
    context.font = '16px Arial, sans-serif';
    context.fillText(object.name, originX + object.xMm * scale + 8, originY + object.yMm * scale + 24);
  }

  context.fillStyle = '#3F3944';
  context.font = '24px Arial, sans-serif';
  context.fillText(`Помещений: ${areas.length}`, 72, 1480);
  context.fillText(`Проёмов: ${project.room.openings?.length ?? 0}`, 72, 1522);
  context.fillText(`Перегородок: ${project.room.partitions?.length ?? 0}`, 72, 1564);
  context.fillText(`Объектов: ${project.objects.length}`, 72, 1606);
  return canvas;
}

function drawWallPages(project: TileProject) {
  const walls = project.surfaces.filter((surface) => surface.type === 'wall');
  const pages: HTMLCanvasElement[] = [];
  for (let offset = 0; offset < walls.length; offset += 6) {
    const { canvas, context } = createPage(`Стены${walls.length > 6 ? ` · ${Math.floor(offset / 6) + 1}` : ''}`);
    walls.slice(offset, offset + 6).forEach((wall, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 72 + column * 555;
      const y = 210 + row * 465;
      const scale = Math.min(490 / Math.max(1, wall.widthMm), 340 / Math.max(1, wall.heightMm));
      const width = wall.widthMm * scale;
      const height = wall.heightMm * scale;
      context.fillStyle = '#FAF7FC';
      context.fillRect(x, y + 44, width, height);
      context.strokeStyle = '#9A7AB8';
      context.lineWidth = 3;
      context.strokeRect(x, y + 44, width, height);
      for (const opening of wall.openings) {
        context.fillStyle = '#FFFFFF';
        context.fillRect(x + opening.xMm * scale, y + 44 + opening.yMm * scale, opening.widthMm * scale, opening.heightMm * scale);
        context.strokeStyle = '#6F4F93';
        context.setLineDash([8, 5]);
        context.strokeRect(x + opening.xMm * scale, y + 44 + opening.yMm * scale, opening.widthMm * scale, opening.heightMm * scale);
        context.setLineDash([]);
      }
      context.fillStyle = '#4E4458';
      context.font = '600 20px Arial, sans-serif';
      context.fillText(`${wall.name} · ${wall.widthMm} × ${wall.heightMm} мм`, x, y + 25);
    });
    pages.push(canvas);
  }
  return pages;
}

function drawCalculationPages(project: TileProject, calculation: ProjectCalculation) {
  const rows = calculation.materials.flatMap((entry) => [
    { strong: true, text: `${entry.material.name}: ${entry.purchasePieces} шт. к покупке · ${entry.areaM2.toFixed(2)} м²${entry.boxes === null ? '' : ` · ${entry.boxes} кор.`}` },
    ...entry.zones.map((zone) => ({ strong: false, text: `${zone.surfaceName} / ${zone.zoneName}: ${zone.totalPieces} шт. + ${zone.reservePieces} запас · ${zone.areaM2.toFixed(2)} м²` })),
  ]);
  const chunks = rows.length ? Array.from({ length: Math.ceil(rows.length / 24) }, (_, index) => rows.slice(index * 24, index * 24 + 24)) : [[]];
  return chunks.map((chunk, pageIndex) => {
    const { canvas, context } = createPage(`Расчёт плитки${chunks.length > 1 ? ` · ${pageIndex + 1}` : ''}`);
    if (pageIndex === 0) {
      context.fillStyle = '#F5EFF9';
      context.fillRect(72, 190, PAGE_WIDTH - 144, 170);
      context.fillStyle = '#4E365F';
      context.font = '700 31px Arial, sans-serif';
      context.fillText(`${calculation.totalPurchasePieces} шт. к покупке`, 104, 250);
      context.fillText(`${calculation.totalAreaM2.toFixed(2)} м²`, 104, 305);
      context.font = '24px Arial, sans-serif';
      context.fillText(`Коробок: ${calculation.totalBoxes ?? 'не задано'} · Проект: ${project.name}`, 580, 280);
    }
    let y = pageIndex === 0 ? 420 : 205;
    for (const row of chunk) {
      context.fillStyle = row.strong ? '#5D436F' : '#3F3944';
      context.font = `${row.strong ? '700' : '400'} ${row.strong ? 23 : 20}px Arial, sans-serif`;
      wrapText(context, row.text, 82, y, PAGE_WIDTH - 164, 30);
      y += row.strong ? 52 : 43;
    }
    if (calculation.warnings.length && pageIndex === chunks.length - 1) {
      y += 20;
      context.fillStyle = '#A04D60';
      context.font = '600 20px Arial, sans-serif';
      wrapText(context, `Предупреждения: ${calculation.warnings.join(' · ')}`, 82, y, PAGE_WIDTH - 164, 30);
    }
    return canvas;
  });
}

function drawTag(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.font = '16px Arial, sans-serif';
  const width = context.measureText(text).width + 18;
  context.fillStyle = '#FFFFFF';
  context.fillRect(x - width / 2, y - 14, width, 26);
  context.strokeStyle = '#D5C6DF';
  context.lineWidth = 1;
  context.strokeRect(x - width / 2, y - 14, width, 26);
  context.fillStyle = '#312D34';
  context.fillText(text, x - width / 2 + 9, y + 5);
}

function wrapText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(line, x, y);
      y += lineHeight;
      line = word;
    } else line = test;
  }
  if (line) context.fillText(line, x, y);
}

function buildImagePdf(dataUrls: string[]) {
  const encoder = new TextEncoder();
  const jpegPages = dataUrls.map(dataUrlToBytes);
  const pageIds = jpegPages.map((_, index) => 3 + index * 3);
  const objects: Array<{ id: number; chunks: Uint8Array[] }> = [
    { id: 1, chunks: [encoder.encode('<< /Type /Catalog /Pages 2 0 R >>')] },
    { id: 2, chunks: [encoder.encode(`<< /Type /Pages /Count ${jpegPages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`)] },
  ];
  jpegPages.forEach((jpeg, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const content = encoder.encode(`q\n595 0 0 842 0 0 cm\n/Im${index} Do\nQ`);
    objects.push(
      { id: pageId, chunks: [encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)] },
      { id: contentId, chunks: [encoder.encode(`<< /Length ${content.length} >>\nstream\n`), content, encoder.encode('\nendstream')] },
      { id: imageId, chunks: [encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, encoder.encode('\nendstream')] },
    );
  });
  objects.sort((a, b) => a.id - b.id);
  const chunks: Uint8Array[] = [encoder.encode('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (const object of objects) {
    offsets[object.id] = length;
    const header = encoder.encode(`${object.id} 0 obj\n`);
    const footer = encoder.encode('\nendobj\n');
    chunks.push(header, ...object.chunks, footer);
    length += header.length + object.chunks.reduce((sum, chunk) => sum + chunk.length, 0) + footer.length;
  }
  const xrefOffset = length;
  const maxId = objects.at(-1)?.id ?? 0;
  const xref = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id <= maxId; id += 1) xref.push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  chunks.push(encoder.encode(xref.join('')));
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

function dataUrlToBytes(dataUrl: string) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
