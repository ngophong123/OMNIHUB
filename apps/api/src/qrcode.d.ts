declare module 'qrcode' {
  type SvgOptions = { type: 'svg'; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'; margin?: number; width?: number; color?: { dark?: string; light?: string } };
  export function toString(text: string, options: SvgOptions): Promise<string>;
}
