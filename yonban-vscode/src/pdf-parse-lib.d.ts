declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
  }
  function pdf(dataBuffer: Buffer | Uint8Array): Promise<PdfParseResult>;
  export = pdf;
}
