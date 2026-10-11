declare module "sqlite-vec" {
  /** 返回当前平台可加载的 vec0 扩展路径。 */
  export function getLoadablePath(): string;
  /** 将扩展加载到给定数据库连接。 */
  export function load(db: unknown): void;
}
