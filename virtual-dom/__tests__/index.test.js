import { VNode, diff, patch } from "../index.js";
import { describe, it, expect } from "vitest";

describe("virtual-dom", () => {
  describe("VNode", () => {
    it("应该正确创建虚拟节点", () => {
      const vnode = new VNode("div", { id: "app" }, ["Hello"]);
      expect(vnode.type).toBe("div");
      expect(vnode.props).toEqual({ id: "app" });
      expect(vnode.children).toEqual(["Hello"]);
    });
  });

  describe("diff算法", () => {
    it("应该检测属性变化", () => {
      const oldNode = new VNode("div", { id: "old" }, []);
      const newNode = new VNode("div", { id: "new" }, []);
      const patches = diff(oldNode, newNode);
      expect(patches).toMatchSnapshot();
    });

    it("应该处理子节点变化", () => {
      const oldNode = new VNode("div", {}, [new VNode("span")]);
      const newNode = new VNode("div", {}, [new VNode("div")]);
      expect(diff(oldNode, newNode)).toMatchSnapshot();
    });
  });

  describe("patch应用", () => {
    it("应该正确更新DOM属性", () => {
      const dom = document.createElement("div");
      dom.id = "old";
      const vnode = new VNode("div", { id: "new" }, []);
      patch(dom, diff(null, vnode));
      expect(dom.id).toBe("new");
    });
  });
});
