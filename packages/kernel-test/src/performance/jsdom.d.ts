// `jsdom` ships no types, and this package compiles without the DOM library,
// so this declares only what `report.ts` uses to build SVG off-screen.
declare module 'jsdom' {
  export type SvgElement = {
    setAttribute: (name: string, value: string) => void;
    append: (child: SvgElement) => void;
    textContent: string | null;
    readonly outerHTML: string;
  };

  export type SvgDocument = {
    createElementNS: (namespace: string, tag: string) => SvgElement;
  };

  /**
   * A DOM, here for building SVG off-screen.
   */
  export class JSDOM {
    /**
     * Make a DOM.
     *
     * @param html - The document's markup.
     */
    constructor(html?: string);

    readonly window: { readonly document: SvgDocument };
  }
}
