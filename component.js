import { patch, diff } from "./virtual-dom";
import {
  processUpdateQueue,
  enqueueUpdate,
  startTransition as globalStartTransition,
  UpdatePriorities,
} from "./update-queue";

let contextIdCounter = 0;

export function createContext(defaultValue) {
  const contextId = `context_${contextIdCounter++}`;

  class Provider extends Component {
    /**
     * 定义静态属性，这些静态成员属于类本身，而不是类的实例，无法通过实例调用，只能被类本身调用
     *  这里将context对象关联到Provider类上，方便访问
     */
    static contextType = Context;

    componentDidMount() {
      this.updateContextValue(this.props.value);
    }

    componentDidUpdate(prevProps) {
      if (!Object.is(this.props.value, prevProps.value)) {
        this.updateContextValue(this.props.value);
      }
    }

    updateContextValue(value) {
      const context = Provider.contextType;
      context._currentValue = value;

      context._subscribers.forEach((componentInstance) => {
        enqueueUpdate(componentInstance);
      });
    }

    render() {
      // Provider只渲染子节点
      return this.props.children;
    }
  }

  const Context = {
    _id: contextId,
    _defaultValue: defaultValue,
    _currentValue: defaultValue, // 当前值，Provider会更新它
    _subscribers: new Set(), // 存储订阅了此context的组件实例
    Provider: Provider,
    Consumer: null, // 之后实现
  };

  return Context;
}

export class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
    this.__internalInstance = null;
    this.__pendingState = null; // 暂存待更新状态
    this.__isMounted = false; // 挂载状态标识
    this.__domNode = null; // dom节点引用
    this.__pendingProps = null; // props更新标记
    this.__hasError = false;
    // 存储并发效果，并发模式允许react中断渲染过程以处理更高优先级的任务，可能导致某些副作用
    // 比如DOM操作被中断，从而需要清理未完成的效果，避免UI不一致
    this.__concurrentEffects = [];
    this.__invocationCount = 0;
    // Suspense组件的componentDidCatch方法会捕获Promise，__suspendedPromise用于存储被挂起的promise
    // 当promise被解决时，触发重新渲染
    this.__suspendedPromise = null;
    this.__pendingBackgroundState = null; // 延迟或批量处理某些状态更新，并发模式下暂存状态
    this.__hooks = [];
    this.__hookIndex = 0; // 当前hook索引
    this.__pendingEffects = []; // 待执行的effect
    this.__layoutEffects = []; // 布局Effect
    this.__isRenderPhase = false; // 渲染阶段标识
  }

  // 切换hooks的分发器，保存当前dispatcher，并返回一个恢复函数
  __withHooksDispatcher(dispatcher) {
    const prevDispatcher = this.__currentDispatcher;
    this.__currentDispatcher = dispatcher;
    return () => {
      this.__currentDispatcher = prevDispatcher;
      this.__hookIndex = 0;
    };
  }

  // render方法是必须由子类实现的核心渲染方法（在组件中常写的return后的内容）
  render() {
    throw new Error(
      `${this.constructor.name} 组件必须实现 render 方法。请检查以下组件：\n` +
        `类定义位置: ${this.constructor.toString().split("{")[0].trim()}\n` +
        `文件路径: ${import.meta.url || window.location.href}`
    );
  }

  forceUpdate(callback) {
    this.__pendingCallback = callback;
    enqueueUpdate(this, true); // 强制更新
  }

  __updateProps(newProps) {
    this.__pendingProps = newProps;
    enqueueUpdate(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  // 用于处理promise状态
  static suspend(promise) {
    if (promise.status === "fulfilled") {
      return promise.result;
    } else if (promise.status === "pending") {
      // 抛出promise，触发Suspense组件
      throw promise;
    } else if (promise.status === "rejected") {
      throw promise.result;
    } else {
      // promsie的初始状态，第一次传入时为undefined
      promise.status = "pending";
      promise.then(
        (result) => {
          promise.status = "fulfilled";
          promise.result = result;
          enqueueUpdate(this); //触发重新渲染
        },
        (error) => {
          promise.status = "rejected";
          promise.result = error;
          enqueueUpdate(this); //触发重新渲染
        }
      );
      throw promise;
    }
  }

  componentDidCatch(error, info) {
    console.error("Component Error:", error, info);
    this.__hasError = true;
  }

  setState(partialState, callback) {
    if (typeof partialState === "function") {
      partialState = partialState(this.state, this.props);
    }
    // 合并状态
    this.__pendingState = { ...this.state, ...partialState };
    this.__pendingCallback = callback;
    enqueueUpdate(this);
  }

  // 生命周期方法
  // 已挂载
  componentDidMount() {
    this.__isMounted = true;
  }
  shouldComponentUpdate(nextProps, nextState) {
    // 性能优化关键点，返回true表示允许更新
    const propsChanged = !shallowEqual(this.props, nextProps);
    const stateChanged = !shallowEqual(this.state, nextState);
    return propsChanged || stateChanged;
  }

  // 捕获可能丢失的UI状态（如滚动位置，输入框焦点等）
  // 将捕获的信息通过参数传递给componentDidUpdate，实现更新前后的状态衔接
  // 通过返回值判断是否发生了特定属性变化
  getSnapshotBeforeUpdate(prevProps, prevState) {
    // 列表新增项时保持滚动位置
    if (prevProps.items.length < this.props.items.length) {
      return {
        type: "SCROLL_POSITION",
        value: this.__domNode.scrollHeight - this.__domNode.scrollTop,
      };
    }
    // 颜色变化保留 供动画使用
    if (this.props.color !== prevProps.color) {
      return {
        type: "COLOR_CHANGE",
        oldValue: prevProps.color,
        newValue: this.props.color,
      };
    }

    // 输入框内容变化时保存选区状态
    if (this.props.isInput && prevProps.value !== this.props.value) {
      return {
        type: "INPUT_SELECTION",
        selectionStart: this.__domNode.selectionStart,
        selectionEnd: this.__domNode?.selectionEnd,
      };
    }
    return null;
  }

  componentDidUpdate(prevProps, prevState, snapshot) {
    if (!snapshot) return;

    switch (snapshot.type) {
      case "SCROLL_POSITION":
        if (this.__domNode) {
          this.__domNode.scrollTop =
            this.__domNode.scrollHeight - snapshot.value;
        }
        break;

      case "COLOR_CHANGE":
        this.__previousColor = snapshot.oldValue;
        // 触发颜色过渡动画
        if (this.__domNode) {
          this.__domNode.style.transition = "background 0.3s";
          this.__domNode.style.background = snapshot.newValue;
        }
        break;

      case "INPUT_SELECTION":
        if (this.__domNode) {
          this.__domNode.setSelectionRange(
            snapshot.selectionStart,
            snapshot.selectionEnd
          );
        }
        break;
    }

    if (this.__concurrentEffects) {
      this.__flushConcurrentEffects();
    }

    // 严格模式下，组件会被渲染两次，以暴露潜在的问题
    if (this.__strictMode) {
      this.__handleDoubleInvocation(prevProps, prevState);
    }

    if (this.__pendingBackgroundState) {
      this.setState(this.__pendingBackgroundState);
      this.__pendingBackgroundState = null;
    }

    if (
      this.__suspendedPromise &&
      this.__suspendedPromise.status === "fulfilled"
    ) {
      this.__retrySuspendedRender();
    }

    if (startTransition.isPending) {
      this.__deferNonCriticalWork();
    }
  }
  componentWillUnmount() {
    this.__isMounted = false;
  }
  __updateComponent(forceUpdate = false) {
    if (this.__hasError) return;
    const hasPropsUpdate = !!this.__pendingProps;
    const hasStateUpdate = !!this.__pendingState;
    if (
      !forceUpdate &&
      !this.shouldComponentUpdate(
        this.__pendingProps || this.props,
        this.__pendingState || this.state
      )
    )
      return;
    const prevProps = this.props;
    const prevState = this.state;
    if (hasPropsUpdate) {
      this.props = this.__pendingProps;
      this.__pendingProps = null;
    }
    if (hasStateUpdate) {
      this.state = this.__pendingState;
      this.__pendingState = null;
    }
    // 触发更新前生命周期
    const snapshot = this.getSnapshotBeforeUpdate(prevProps, prevState);
    const oldVNode = this.__internalInstance;
    const newVNode = this.render();
    const patches = diff(oldVNode, newVNode);
    if (this.__domNode && this.__domNode.parentNode) {
      patch(this.__domNode.parentNode, patches);
    }

    // 更新内部引用
    this.__internalInstance = newVNode;
    // 触发更新后生命周期
    this.componentDidUpdate(prevProps, prevState, snapshot);
    this.__flushEffects();

    this.__pendingCallback?.();
    this.__pendingCallback = null;
  }
  // 主要实现渲染过程的主动中断，恢复机制
  __suspendRendering() {
    // 检查是否需要让出主线程
    if (concurrency.shouldYield()) {
      // 标记状态为暂停并抛出错误中断渲染流程
      this.__renderingStatus = "suspended";
      throw new Error("SUSPEND");
    }
  }
  __flushEffects() {
    this.__layoutEffects.forEach((effect) => {
      if (effect.cleanup) effect.cleanup();
      effect.cleanup = effect.setup();
    });
    // 此处只是模拟异步处理
    if (this.__pendingEffects.length > 0) {
      setTimeout(() => {
        this.__pendingEffects.forEach((effect) => {
          if (effect.cleanup) effect.cleanup();
          effect.cleanup = effect.setup();
        });
        this.__pendingEffects = [];
      }, 0);
    }
  }

  __flushConcurrentEffects() {
    // 处理并发渲染残留的布局效果
    this.__concurrentEffects.forEach((effect) => {
      if (effect.cleanup) effect.cleanup();
      effect.hasRun = true;
    });
  }

  __handleDoubleInvocation(prevProps, prevState) {
    // 严格模式下的二次调用检测
    if (this.__invocationCount % 2 === 0) {
      console.warn(
        "Strict mode detected unexpected side effects in",
        this.constructor.name
      );
      this.__resetTemporaryState();
    }
    this.__invocationCount++;
  }

  __retrySuspendedRender() {
    // 重试被挂起的渲染
    try {
      const promise = this.__suspendedPromise;
      this.__suspendedPromise = null;
      this.setState({ __retryCount: (this.state.__retryCount || 0) + 1 });
    } catch (e) {
      this.componentDidCatch(e, { componentStack: "" });
    }
  }

  __deferNonCriticalWork() {
    // 延迟非关键工作到空闲时段
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => {
        this.__processDeferredUpdates();
      });
    } else {
      setTimeout(this.__processDeferredUpdates, 0);
    }
  }
}

export class Suspense extends Component {
  constructor(props) {
    super(props);
    // 用于控制是否显示fallback ui
    this.state = { hasError: false };
  }

  // 用于捕获Promise
  componentDidCatch(error) {
    if (error instanceof Promise) {
      globalStartTransition(() => {
        error.then(() => this.setState({ hasError: false }));
      });
      this.setState({ hasError: true });
    } else {
      throw error;
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
// 浅比较
function shallowEqual(objA, objB) {
  if (Object.is(objA, objB)) return true;
  if (
    typeof objA !== "object" ||
    objA === null ||
    typeof objB !== "object" ||
    objB === null
  ) {
    return false;
  }

  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;

  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(objB, key) &&
      Object.is(objA[key], objB[key])
  );
}

const HooksDispatcher = {
  useState: function (initialState) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance; // 当前组件实例

    if (!component.__hooks[hookIndex]) {
      component.__hooks[hookIndex] = {
        state:
          typeof initialState === "function" ? initialState() : initialState,
        queue: [], // 状态更新队列
      };
    }

    const hook = component.__hooks[hookIndex];
    const queue = [...hook.queue];
    hook.queue = [];

    let newState = queue.reduce((state, action) => {
      return typeof action === "function" ? action(state) : action;
    }, hook.state);

    hook.state = newState;

    const setState = (action) => {
      hook.queue.push(action); // 更新加入队列
      enqueueUpdate(component); // 触发更新
    };

    return [hook.state, setState];
  },
  // 异步的，会在浏览器绘制后执行，避免阻塞页面渲染
  // 关于useEffect和useLayoutEffect: hooks数组是用于确保hook的顺序和状态持久化，hooks数组存储所有的hook
  // 而effect队列是管理执行时机在组件更新后，__flushEffects被调用

  useEffect: function (setup, deps) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    const effect = {
      setup,
      deps,
      cleanup: null,
    };
    if (!component.__hooks[hookIndex]) {
      component.__hooks[hookIndex] = effect;
      component.__pendingEffects.push(effect); // 加入异步队列
    } else {
      const prevEffect = component.__hooks[hookIndex];
      if (shallowEqual(prevEffect.deps, deps)) return;
      prevEffect.cleanup = effect.setup();
    }
  },
  // 会在DOM更新后同步执行，适合需要立即操作DOM的场景
  useLayoutEffect: function (setup, deps) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    const effect = {
      setup,
      deps,
      cleanup: null,
    };
    if (!component.__hooks[hookIndex]) {
      component.__hooks[hookIndex] = effect;
      component.__layoutEffects.push(effect);
    } else {
      const prevEffect = component.__hooks[hookIndex];
      if (shallowEqual(prevEffect.deps, deps)) return;
      if (prevEffect.cleanup) prevEffect.cleanup();
      component.__layoutEffects.push(effect);
      component.__hooks[hookIndex] = effect;
    }
  },
  useRef: function (initialValue) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    if (!component.__hooks[hookIndex]) {
      component.__hooks[hookIndex] = { current: initialValue };
    }
    return component.__hooks[hookIndex];
  },
  // useCallback返回出来的是一个函数
  useCallback: function (callback, deps) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    if (!component.__hooks[hookIndex]) {
      component.__hooks[hookIndex] = { callback, deps };
    } else {
      const prevHook = component.__hooks[hookIndex];
      if (shallowEqual(prevHook.deps, deps)) {
        return prevHook.callback;
      }
      component.__hooks[hookIndex] = { callback, deps };
    }
    return callback;
  },
  useMemo: function (create, deps) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    if (!component.__hooks[hookIndex]) {
      const value = create();
      component.__hooks[hookIndex] = { value, deps };
      return value;
    } else {
      const prevHook = component.__hooks[hookIndex];
      if (shallowEqual(prevHook.deps, deps)) {
        return prevHook.value;
      }
      const value = create();
      component.__hooks[hookIndex] = { value, deps };
      return value;
    }
  },
  useReducer: function (reducer, initialArg, init) {
    const hookIndex = this.__hookIndex++;
    const component = this.__currentInstance;
    if (!component.__hooks[hookIndex]) {
      const initialState = init ? init(initialArg) : initialArg;
      component.__hooks[hookIndex] = {
        state: initialState,
        reducer,
        queue: [],
      };
    }
    const hook = component.__hooks[hookIndex];
    const queue = [...hook.queue];
    hook.queue = [];

    let newState = queue.reduce((state, action) => {
      return hook.reducer(state, action);
    }, hook.state);

    hook.state = newState;

    const dispatch = (action) => {
      hook.queue.push(action);
      enqueueUpdate(component);
    };

    return [hook.state, dispatch];
  },
  useTransition: function () {
    const component = this.__currentInstance;
    const pendingStateHookIndex = this.__hookIndex++;
    if (!component.__hooks[pendingStateHookIndex]) {
      component.__hooks[pendingStateHookIndex] = {
        state: false,
        queue: [],
      };
    }
    const pendingHook = component.__hooks[pendingStateHookIndex];
    const pendingQueue = [...pendingHook.queue];
    pendingHook.queue = [];
    let isPending = pendingQueue.reduce((state, action) => {
      return typeof action === "function" ? action(state) : action;
    }, pendingHook.state);
    pendingHook.state = isPending;
    const setIsPending = (action) => {
      pendingHook.queue.push(action);
      // isPending状态的更新应该是高优先级的，立即反映UI变化，如果开发者使用了isPending来控制UI
      enqueueUpdate(component, false, UpdatePriorities.UserBlockingPriority);
    };
    const startTransition = (scope) => {
      setIsPending(true);
      globalStartTransition(() => {
        try {
          scope();
        } finally {
          /**
           * 为什么异步地将isPending设置为false?
           * 在scope函数内部，任何调用setState或dispatch的操作，因为当前优先级是低的，这些低优先级的任务不会被立即执行，需要等待浏览器空闲或者高优先级任务完成后
           * 如果setIsPending是同步的，会导致isPending状态过早的变为false
           * 而我们这里只是简单模拟，实际react中调度更精确
           */
          setTimeout(() => {
            setIsPending(false);
          }, 0);
        }
      });
    };
    return [isPending, startTransition];
  },
  useContext: function (Context) {},
};

Component.prototype.useState = function (initialState) {
  return this.__currentDispatcher.useState(initialState);
};

const originalRender = Component.prototype.render;
Component.prototype.render = function () {
  const resetDispatcher = this.__withHooksDispatcher(HooksDispatcher);
  this.__currentInstance = this;
  const result = originalRender.call(this);
  resetDispatcher();
  return result;
};
