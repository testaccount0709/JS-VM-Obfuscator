declare module "lzma" {
  interface LZMACompressOptions {
    // No options needed for basic usage
  }

  interface LZMA {
    compress(data: Uint8Array | number[], level: number, callback: (result: number[] | null) => void): void;
    default: {
      compress(data: Uint8Array | number[], level: number, callback: (result: number[] | null) => void): void;
    };
  }
  const lzma: LZMA;
  export default lzma;
  export = lzma;
}