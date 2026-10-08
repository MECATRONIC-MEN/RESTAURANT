/** Formatos de hoja QR incluidos. Las fracciones son del ancho y alto de la imagen. */
export const QR_PRINT_FORMATS = [
  {
    id: 'bar',
    name: 'Bar',
    src: '/qr-formats/bar.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.327, y: 0.45, w: 0.343, h: 0.213 },
    logo: { x: 0.33, y: 0.062, w: 0.34, h: 0.125 },
  },
  {
    id: 'heladeria',
    name: 'Heladería',
    src: '/qr-formats/heladeria.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.33, y: 0.44, w: 0.337, h: 0.217 },
    logo: { x: 0.31, y: 0.05, w: 0.38, h: 0.145 },
  },
  {
    id: 'polleria',
    name: 'Pollería',
    src: '/qr-formats/polleria.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.333, y: 0.442, w: 0.337, h: 0.213 },
    logo: { x: 0.32, y: 0.052, w: 0.36, h: 0.14 },
  },
  {
    id: 'rio',
    name: 'Río',
    src: '/qr-formats/rio.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.33, y: 0.435, w: 0.337, h: 0.207 },
    logo: { x: 0.3, y: 0.042, w: 0.4, h: 0.145 },
  },
  {
    id: 'parrilla',
    name: 'Parrilla',
    src: '/qr-formats/parrilla.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.333, y: 0.438, w: 0.331, h: 0.203 },
    logo: { x: 0.32, y: 0.048, w: 0.36, h: 0.14 },
  },
  {
    id: 'restaurante',
    name: 'Restaurante',
    src: '/qr-formats/restaurante.jpg',
    logoShape: 'roundrect',
    qr: { x: 0.333, y: 0.435, w: 0.334, h: 0.205 },
    logo: { x: 0.355, y: 0.036, w: 0.29, h: 0.128 },
  },
  {
    id: 'playa',
    name: 'Playa',
    src: '/qr-formats/playa.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.318, y: 0.438, w: 0.358, h: 0.223 },
    logo: { x: 0.3, y: 0.032, w: 0.4, h: 0.15 },
  },
  {
    id: 'restobar',
    name: 'Restobar',
    src: '/qr-formats/restobar.jpg',
    logoShape: 'roundrect',
    qr: { x: 0.333, y: 0.437, w: 0.331, h: 0.203 },
    logo: { x: 0.34, y: 0.028, w: 0.32, h: 0.132 },
  },
  {
    id: 'selva',
    name: 'Selva',
    src: '/qr-formats/selva.jpg',
    logoShape: 'ellipse',
    qr: { x: 0.326, y: 0.455, w: 0.346, h: 0.23 },
    logo: { x: 0.27, y: 0.032, w: 0.46, h: 0.155 },
  },
];

export function qrPrintFormatBySrc(src) {
  const value = String(src || '');
  if (!value) return null;
  return QR_PRINT_FORMATS.find((item) => value === item.src || value.endsWith(item.src)) || null;
}
