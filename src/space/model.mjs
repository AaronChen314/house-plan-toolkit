// 兼容出口：空间模型的纯函数已下沉到 src/domain/，这里保留原调用点。
// 新代码请直接引用 ../domain/index.mjs。
export {pointInRing, pointInPoly, boundsOf, polygonsIntersect} from '../domain/geometry.mjs';
export {resolveLevels, furnitureHeight} from '../domain/levels.mjs';
export {prepareModel, validateModel} from '../domain/model.mjs';
