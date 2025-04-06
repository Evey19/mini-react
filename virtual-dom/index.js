// 创建虚拟DOM节点
export class VNode {
  constructor(type, props, children) {
    this.type = type;
    this.props = props;
    this.children = children;
  }
}

// diff函数，对比新旧虚拟节点，返回差异补丁数组
export function diff(oldNode, newNode) {
  const patches = [];
  dfsWalk(oldNode, newNode, patches);
  return patches;
}

function dfsWalk(oldNode, newNode, patches, index = 0) {
  // 每处理3个节点检查一次是否需要暂停
  if (index % 3 === 0 && concurrency.shouldYield()) {
    patches.push({ type: 'PAUSE', index });
    return;
  }
  if (!oldNode && !newNode) return;

  if (!newNode) {
    patches.push({ type: "REMOVE", index });
  } else if (!oldNode) {
    patches.push({ type: "ADD", newNode, index });
  } else if (oldNode.type !== newNode.type) {
    patches.push({ type: "REPLACE", newNode, index });
  } else {
    const propsPatches = diffProps(oldNode.props, newNode.props);
    if (Object.keys(propsPatches).length > 0) {
      patches.push({ type: "UPDATE_PROPS", props: propsPatches, index });
    }
    const childrenPatches = diffChildren(oldNode.children, newNode.children);
    patches.push(...childrenPatches);
  }
}

// 对比新旧节点属性
function diffProps(oldProps, newProps) {
  const patches = {};

  // 检查移除的属性
  Object.keys(oldProps).forEach((key) => {
    if (!(key in newProps)) {
      patches[key] = null;
    }
  });

  // 检查新增/修改的属性
  Object.keys(newProps).forEach((key) => {
    if (oldProps[key] !== newProps[key]) {
      // 特殊处理样式对象
      if (key === "style") {
        const stylePatches = {};
        Object.keys(newProps.style).forEach((styleKey) => {
          if (oldProps.style[styleKey] !== newProps.style[styleKey]) {
            stylePatches[styleKey] = newProps.style[styleKey];
          }
        });
        Object.keys(oldProps.style).forEach((styleKey) => {
          if (!(styleKey in newProps.style)) {
            stylePatches[styleKey] = "";
          }
        });
        patches.style = stylePatches;
      } else if (key.startsWith("on")) {
        // 处理事件监听器
        patches[key] = newProps[key];
      } else {
        patches[key] = newProps[key];
      }
    }
  });

  return patches;
}

// 应用差异补丁到真实DOM
export function patch(parentDom, patches) {
  let resumeIndex = -1;
  
  try {
    patches.forEach((patch, i) => {
      if (patch.type === 'PAUSE') throw i; // 抛出当前索引
      const node = parentDom.childNodes[patch.index];

      switch (patch.type) {
        case "ADD":
          const newNode = createElement(patch.newNode);
          parentDom.appendChild(newNode);
          break;
        case "REMOVE":
          node.remove();
          break;
        case "REPLACE":
          const newReplaceNode = createElement(patch.newNode);
          parentDom.replaceChild(newReplaceNode, node);
          break;
        case "UPDATE_PROPS":
          Object.keys(patch.props).forEach((key) => {
            if (key.startsWith("on")) {
              // 移除旧事件监听器
              const eventType = key.toLowerCase().substring(2);
              node.removeEventListener(eventType, node._listeners?.[eventType]);

              // 添加新事件监听器
              const newHandler = patch.props[key];
              node.addEventListener(eventType, newHandler);
              node._listeners = node._listeners || {};
              node._listeners[eventType] = newHandler;
            } else if (key === "style") {
              // 应用样式补丁
              Object.keys(patch.props.style).forEach((styleKey) => {
                node.style[styleKey] = patch.props.style[styleKey];
              });
            } else {
              node[key] = patch.props[key];
            }
          });
          break;
      }
    });
  } catch (e) {
    if (typeof e === 'number') {
      resumeIndex = e;
      requestIdleCallback(() => {
        patch(parentDom, patches.slice(resumeIndex));
      });
    }
  }
}

// 创建真实DOM元素
function createElement(vnode) {
  if (typeof vnode === "string") {
    return document.createTextNode(vnode);
  }

  const el = document.createElement(vnode.type);

  // 设置属性
  if (vnode.props) {
    Object.keys(vnode.props).forEach((key) => {
      if (key.startsWith("on")) {
        const eventType = key.toLowerCase().substring(2);
        el.addEventListener(eventType, vnode.props[key]);
        el._listeners = el._listeners || {};
        el._listeners[eventType] = vnode.props[key];
      } else if (key === "style") {
        Object.assign(el.style, vnode.props.style);
      } else {
        el[key] = vnode.props[key];
      }
    });
  }

  // 递归创建子节点
  if (vnode.children) {
    vnode.children.forEach((child) => {
      el.appendChild(createElement(child));
    });
  }

  return el;
}

function diffChildren(oldChildren, newChildren) {
  const patches = [];
  // 用于存储旧子节点中带有key属性的节点索引
  const keyIndexMap = {};

  // 构建旧子节点key索引
  oldChildren.forEach((child, index) => {
    if (child.props?.key) {
      keyIndexMap[child.props.key] = index;
    }
  });

  let newIndex = 0;
  let oldIndex = 0;

  while (newIndex < newChildren.length || oldIndex < oldChildren.length) {
    const newChild = newChildren[newIndex];
    const oldChild = oldChildren[oldIndex];

    if (!oldChild) {
      // 新增节点
      patches.push({
        type: "ADD",
        newNode: newChild,
        index: newIndex,
      });
      newIndex++;
    } else if (!newChild) {
      // 移除节点
      patches.push({
        type: "REMOVE",
        index: oldIndex,
      });
      oldIndex++;
    } else if (isSameNode(oldChild, newChild)) {
      // 节点相同，递归diff函数进行更差异化的比较
      const childPatches = diff(oldChild, newChild);
      patches.push(
        ...childPatches.map((patch) => ({
          ...patch,
          index: oldIndex,
        }))
      );
      newIndex++;
      oldIndex++;
    } else {
      //节点不同情况下首先尝试通过key匹配
      if (newChild.props?.key in keyIndexMap) {
        const matchedOldIndex = keyIndexMap[newChild.props.key];
        const matchedOldChild = oldChildren[matchedOldIndex];

        if (isSameNode(matchedOldChild, newChild)) {
          // 移动节点
          patches.push({
            type: "MOVE",
            fromIndex: matchedOldIndex,
            toIndex: newIndex,
          });
          oldChildren.splice(matchedOldIndex, 1);
          oldChildren.splice(oldIndex, 0, matchedOldChild);
          newIndex++;
          continue;
        }
      }

      // 替换节点
      patches.push({
        type: "REPLACE",
        newNode: newChild,
        index: oldIndex,
      });
      newIndex++;
      oldIndex++;
    }
  }

  return patches;
}

// 为什么通过type来判断了还要key来判断呢？
// 因为在更新列表时，若仅依靠type来判断，当列表顺序发生变化时，可能会导致不必要的DOM操作
function isSameNode(a, b) {
  return a.type === b.type && a.props?.key === b.props?.key;
}
