/**
 * Ambient types for the pdf-parse subpath import used by pre-evaluation.ts.
 *
 * The package index (`pdf-parse`) is avoided on purpose: pdf-parse@1.1.1's
 * index.js parses a bundled test PDF at require time, which is wasteful and
 * brittle under bundlers/vitest. `lib/pdf-parse.js` is the clean entry point;
 * @types/pdf-parse only covers the index, so the subpath needs this
 * declaration. The lib file is CommonJS (`module.exports = PDF`), so the
 * default export below matches Vite/Node interop.
 */
declare module "pdf-parse/lib/pdf-parse.js" {
	/** Result of a successful text extraction. */
	interface PdfParseResult {
		/** Plain-text content of the PDF ("" when no text was extracted). */
		text: string;
		numpages: number;
		numrender: number;
		info: unknown;
		metadata: unknown;
		version: string;
	}

	/**
	 * Extract text from a PDF buffer.
	 * @param dataBuffer Raw PDF bytes.
	 * @param options Optional pdf.js options (pagerender, max, version).
	 */
	function pdfParse(
		dataBuffer: Buffer | Uint8Array | ArrayBuffer,
		options?: Record<string, unknown>,
	): Promise<PdfParseResult>;

	export default pdfParse;
}
