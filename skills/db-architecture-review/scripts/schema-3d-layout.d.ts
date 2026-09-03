export interface Island { key: string; title: string; color: string; tables: string[]; cols: number; rows: number; w: number; d: number; cx: number; cz: number }
export interface Arc { i: number; kind: 'self' | 'inner' | 'cross'; lift: number }
export interface Layout { islands: Island[]; pos: Record<string, { x: number; z: number }>; arcs: Arc[]; radius: number }
export const CARD: { w: number; d: number; h: number; stepX: number; stepZ: number; pad: number };
export const ISLAND_GAP: number;
export function depths(model: { tables: { name: string }[]; fks: { child: string; parent: string }[] }): Map<string, number>;
export function layout(model: { domains: { key: string; title: string; color: string }[]; tables: { name: string; domain: string }[]; fks: { child: string; parent: string }[]; hubs: string[] }): Layout;
