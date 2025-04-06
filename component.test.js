import { describe, it, expect, vi } from "vitest";
import { Component } from "./component";

describe("Component", () => {
  it("should initialize with props and state", () => {
    const props = { name: "Test" };
    const component = new Component(props);
    expect(component.props).toEqual(props);
    expect(component.state).toEqual({});
  });

  it("should update state with setState", () => {
    const component = new Component({});
    component.setState({ count: 1 });
    expect(component.state).toEqual({ count: 1 });
  });

  it("should call forceUpdate", () => {
    const component = new Component({});
    const mockCallback = vi.fn();
    component.forceUpdate(mockCallback);
    // 这里需要模拟更新队列处理
    expect(mockCallback).not.toHaveBeenCalled(); // 暂时验证回调未被立即调用
  });

  it("should handle errors with componentDidCatch", () => {
    const component = new Component({});
    const error = new Error("Test error");
    const info = { componentStack: "test" };
    component.componentDidCatch(error, info);
    expect(component.__hasError).toBe(true);
  });
});
