import type { ProjectCalculation } from '../calculation/calculateProject';
import { getBoundingBox, segmentLength } from '../project/geometry';
import type { PointMm, TileProject } from '../types/project';

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

export interface PackageQuote {
  boxes: number;
  materialId: string;
  packageAreaM2: number;
  pricePerPackage: number;
  total: number;
}

export function exportProjectPdf(
  project: TileProject,
  calculation: ProjectCalculation,
  packageQuotes: PackageQuote[] = [],
) {
  const page = drawReportPage(project, calculation, packageQuotes);
  const blob = buildImagePdf([page.toDataURL('image/jpeg', 0.92)]);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `raschet-plitki-${new Date().toISOString().slice(0, 10)}.pdf`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

function drawReportPage(
  project: TileProject,
  calculation: ProjectCalculation,
  packageQuotes: PackageQuote[],
) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH;
  canvas.height = PAGE_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);

  drawHeader(context, project.name);
  const planBottom = drawFloorPlan(context, project, 210);
  let y = planBottom + 36;

  context.fillStyle = '#2E2A3A';
  context.font = '700 28px Arial, sans-serif';
  context.fillText('Расчёт', 72, y);
  y += 28;

  drawMetricStrip(context, 72, y, [
    [`${calculation.roomCount}`, 'помещений'],
    [`${calculation.totalAreaM2.toFixed(2)} м²`, 'плитки'],
    [`${calculation.totalPurchasePieces}`, 'плиток'],
  ]);
  y += 110;

  context.fillStyle = '#4A2F6A';
  context.font = '650 22px Arial, sans-serif';
  context.fillText('Использованная плитка', 72, y);
  y += 24;

  for (const item of calculation.materials) {
    if (y > PAGE_HEIGHT - 220) break;
    y = drawMaterialRow(context, 72, y, item.material.swatch.value, item.material.name, `${item.purchasePieces} шт · ${item.areaM2.toFixed(2)} м²`);
  }

  y += 18;
  context.fillStyle = '#4A2F6A';
  context.font = '650 22px Arial, sans-serif';
  context.fillText('Упаковки и цена', 72, y);
  y += 24;

  if (!packageQuotes.length) {
    context.fillStyle = '#7A7690';
    context.font = '400 18px Arial, sans-serif';
    context.fillText('Пользователь ещё не рассчитал упаковки в калькуляторе.', 72, y + 8);
    y += 40;
  } else {
    for (const quote of packageQuotes) {
      if (y > PAGE_HEIGHT - 160) break;
      const material = calculation.materials.find((item) => item.material.id === quote.materialId)?.material;
      if (!material) continue;
      y = drawMaterialRow(
        context,
        72,
        y,
        material.swatch.value,
        material.name,
        `${quote.boxes} упак. · ${quote.packageAreaM2} м²/уп · ${formatMoney(quote.pricePerPackage)} ₽/уп · итого ${formatMoney(quote.total)} ₽`,
      );
    }
  }

  const quotedTotal = packageQuotes.reduce((sum, item) => sum + item.total, 0);
  y = Math.max(y + 20, PAGE_HEIGHT - 160);
  context.fillStyle = '#F0E7F8';
  roundRect(context, 72, y, PAGE_WIDTH - 144, 88, 16);
  context.fill();
  context.fillStyle = '#2E2A3A';
  context.font = '600 20px Arial, sans-serif';
  context.fillText('Итого', 96, y + 36);
  context.fillStyle = '#4A2F6A';
  context.font = '700 28px Arial, sans-serif';
  context.fillText(`${formatMoney(quotedTotal)} ₽`, 96, y + 70);
  context.fillStyle = '#5B3F7A';
  context.font = '650 22px Arial, sans-serif';
  context.fillText(`${calculation.totalAreaM2.toFixed(2)} м²`, PAGE_WIDTH - 280, y + 54);

  return canvas;
}

function drawHeader(context: CanvasRenderingContext2D, projectName: string) {
  context.fillStyle = '#FAF8FC';
  context.fillRect(0, 0, PAGE_WIDTH, 168);
  drawLogoMark(context, 72, 48);
  context.fillStyle = '#2E2A3A';
  context.font = '700 34px Arial, sans-serif';
  context.fillText('Посчитай плитку', 148, 78);
  context.fillStyle = '#7A7690';
  context.font = '400 18px Arial, sans-serif';
  context.fillText('vilraystudio.ru', 148, 108);
  context.fillStyle = '#5B3F7A';
  context.font = '600 18px Arial, sans-serif';
  context.fillText(projectName || 'Проект', 148, 136);
  context.strokeStyle = '#E8DFF3';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(72, 168);
  context.lineTo(PAGE_WIDTH - 72, 168);
  context.stroke();
}

function drawLogoMark(context: CanvasRenderingContext2D, x: number, y: number) {
  context.fillStyle = '#A385C4';
  roundRect(context, x, y, 28, 22, 5);
  context.fill();
  context.fillStyle = '#8F6BB8';
  roundRect(context, x + 18, y + 10, 28, 22, 5);
  context.fill();
  context.fillStyle = '#C0A0DC';
  roundRect(context, x + 8, y + 18, 28, 22, 5);
  context.fill();
}

function drawFloorPlan(context: CanvasRenderingContext2D, project: TileProject, top: number) {
  const areas = project.room.areas ?? [{ id: 'room-1', name: 'Помещение 1', contour: project.room.contour }];
  const allPoints = areas.flatMap((area) => area.contour);
  const box = getBoundingBox(allPoints);
  const frameX = 72;
  const frameY = top;
  const frameW = PAGE_WIDTH - 144;
  const frameH = 520;
  context.fillStyle = '#F7F5FA';
  roundRect(context, frameX, frameY, frameW, frameH, 18);
  context.fill();
  context.strokeStyle = '#E8DFF3';
  context.lineWidth = 2;
  context.stroke();

  const padding = 48;
  const scale = Math.min((frameW - padding * 2) / Math.max(1, box.width), (frameH - padding * 2) / Math.max(1, box.height));
  const originX = frameX + (frameW - box.width * scale) / 2 - box.minX * scale;
  const originY = frameY + (frameH - box.height * scale) / 2 - box.minY * scale;
  const point = (value: PointMm) => ({ x: originX + value.x * scale, y: originY + value.y * scale });

  const materialsById = new Map(project.materials.map((material) => [material.id, material]));
  for (const area of areas) {
    const points = area.contour.map(point);
    context.beginPath();
    points.forEach((value, index) => (index ? context.lineTo(value.x, value.y) : context.moveTo(value.x, value.y)));
    context.closePath();
    const floor = project.surfaces.find((surface) =>
      surface.type === 'floor' && (surface.sourceRef?.includes(area.id) || surface.id === 'surface-floor'),
    );
    const material = floor?.zones[0]?.materialId ? materialsById.get(floor.zones[0].materialId) : null;
    context.fillStyle = material?.swatch.type === 'color' ? material.swatch.value : '#F0E7F8';
    context.fill();
    context.strokeStyle = '#8F6BB8';
    context.lineWidth = 5;
    context.stroke();
    context.fillStyle = '#2E2A3A';
    context.font = '600 20px Arial, sans-serif';
    context.fillText(area.name, Math.min(...points.map((item) => item.x)) + 14, Math.min(...points.map((item) => item.y)) + 28);
    area.contour.forEach((start, index) => {
      const end = area.contour[(index + 1) % area.contour.length];
      const a = point(start);
      const b = point(end);
      drawTag(context, `${Math.round(segmentLength(start, end))} мм`, (a.x + b.x) / 2, (a.y + b.y) / 2);
    });
  }

  for (const object of project.objects) {
    context.fillStyle = 'rgba(143, 107, 184, 0.45)';
    context.fillRect(originX + object.xMm * scale, originY + object.yMm * scale, object.lengthMm * scale, object.widthMm * scale);
  }

  context.fillStyle = '#5B3F7A';
  context.font = '600 18px Arial, sans-serif';
  context.fillText('Схема пола', frameX + 22, frameY + 30);
  return frameY + frameH;
}

function drawMetricStrip(context: CanvasRenderingContext2D, x: number, y: number, items: Array<[string, string]>) {
  const width = (PAGE_WIDTH - 144 - 24) / items.length;
  items.forEach(([value, label], index) => {
    const left = x + index * (width + 12);
    context.fillStyle = '#F5F0FA';
    roundRect(context, left, y, width, 78, 14);
    context.fill();
    context.fillStyle = '#2E2A3A';
    context.font = '700 26px Arial, sans-serif';
    context.fillText(value, left + 18, y + 36);
    context.fillStyle = '#7A7690';
    context.font = '400 16px Arial, sans-serif';
    context.fillText(label, left + 18, y + 60);
  });
}

function drawMaterialRow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  title: string,
  detail: string,
) {
  context.fillStyle = '#FFFFFF';
  roundRect(context, x, y, PAGE_WIDTH - 144, 58, 12);
  context.fill();
  context.strokeStyle = '#E8DFF3';
  context.lineWidth = 1.5;
  context.stroke();
  context.fillStyle = color;
  roundRect(context, x + 14, y + 14, 30, 30, 8);
  context.fill();
  context.strokeStyle = 'rgba(82, 70, 94, 0.18)';
  context.stroke();
  context.fillStyle = '#2E2A3A';
  context.font = '650 18px Arial, sans-serif';
  context.fillText(title, x + 56, y + 26);
  context.fillStyle = '#6A6A80';
  context.font = '400 16px Arial, sans-serif';
  context.fillText(detail, x + 56, y + 48);
  return y + 68;
}

function drawTag(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.font = '15px Arial, sans-serif';
  const width = context.measureText(text).width + 16;
  context.fillStyle = '#FFFFFF';
  context.fillRect(x - width / 2, y - 12, width, 24);
  context.strokeStyle = '#DCCEEC';
  context.lineWidth = 1;
  context.strokeRect(x - width / 2, y - 12, width, 24);
  context.fillStyle = '#2E2A3A';
  context.fillText(text, x - width / 2 + 8, y + 5);
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function formatMoney(value: number) {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
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
