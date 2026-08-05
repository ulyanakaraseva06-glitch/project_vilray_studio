export function mmToMetersLabel(mm: number): string {
  return `${(mm / 1000).toLocaleString('ru-RU', {
    maximumFractionDigits: 2,
  })} м`;
}

export function formatRoomSize(widthMm: number, heightMm: number): string {
  return `${mmToMetersLabel(widthMm)} × ${mmToMetersLabel(heightMm)}`;
}
