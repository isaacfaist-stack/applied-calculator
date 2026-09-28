declare module 'clipper-lib' {
  const ClipperLib: any;
  export default ClipperLib;
}
declare module 'shpjs' {
  const getShapefile: (base: ArrayBuffer | string, whiteList?: string[]) => Promise<any>;
  export default getShapefile;
  export function parseShp(shp: ArrayBuffer, prj?: ArrayBuffer | string): any[];
  export function parseDbf(dbf: ArrayBuffer, cpg?: ArrayBuffer | string): any[];
  export function combine(parts: [any[], any[] | undefined]): any;
}
