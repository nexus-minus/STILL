export const SH_COEFFICIENTS: 9;
export function shBasisOrder2(direction: number[]): number[];
export function projectSHOrder2(samples: Array<{direction: number[]; rgb: number[]}>): Float32Array;
export function evaluateSHOrder2(coefficients: ArrayLike<number>, direction: number[]): number[];
export function chooseCellSize(min: number[], max: number[], sampleCount: number, maxCells?: number): number;
export function buildSparseSHGrid(samples: Array<{position: number[]; coefficients: ArrayLike<number>}>, cellSize: number, origin?: number[]): any;
export function sampleSparseSHGrid(grid: any, position: number[], direction: number[]): number[] | null;
export function updateSHGridRegion(grid: any, min: number[], max: number[], replacement: Array<{position: number[]; coefficients: ArrayLike<number>}>): {affectedCells:number; cellsBefore:number; cellsAfter:number};
