if (typeof window !== "undefined" && window.requestIdleCallback) {
  window.requestIdleCallback = function (callback) {
    const start = Date.now();
    return setTimeout(() => {
      callback({
        didTimeout: false,
        timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
      });
    }, 1);
  };
}

const UpdatePriorities = {
  ImmediatePriority: 1, //紧急更新
  UserBlockingPriority: 2, //用户阻塞型更新
  NormalPriority: 3,// 普通更新
  LowPriority: 4, // 过渡更新
  IdlePriority: 5, //空闲更新
};

// 更新队列，每个任务包含组件实例，是否强制更新，优先级
const updateQueue = [];
let isUpdating = false;

// 批量更新队列
const batchUpdates = [];

export function processUpdateQueue() {
  concurrency.startTime = performance.now();
  let currentTask = updateQueue.shift();
  while (currentTask && !concurrency.shouldYield()) {
    currentTask.component.__updateComponent(currentTask.forceUpdate);
    currentTask = updateQueue.shift();
  }
  // 循环结束后，判断是否还有任务未执行，利用requestIdleCallback空闲时间执行
  if (updateQueue.length > 0) {
    requestIdleCallback(processUpdateQueue);
  } else {
    isUpdating = false;
  }
}

// 加入批量更新队列，并根据优先级排序
export function enqueueUpdate(
  component,
  forceUpdate = false,
  priority = UpdatePriorities.NormalPriority
) {
  batchUpdates.push({ component, forceUpdate, priority });
  if (!isUpdating) {
    isUpdating = true;
    flushBatchUpdates();
    processUpdateQueue();
  }
}

// 将批量更新队列中的任务合并到更新队列中，并进行排序
function flushBatchUpdates() {
  batchUpdates.forEach(({ component, forceUpdate, priority }) => {
    const existingIndex = updateQueue.findIndex(
      (t) => t.component === component
    );
    if (existingIndex > -1) {
      // 提升已有任务的优先级
      if (priority > updateQueue[existingIndex].priority) {
        updateQueue[existingIndex].priority = priority;
      }
    } else {
      updateQueue.push({
        component,
        forceUpdate,
        priority,
        startTime: performance.now(),
      });
    }
  });
  updateQueue.sort((a, b) => b.priority - a.priority);
  batchUpdates = [];
}

// 过渡更新方法，会将更新标记为低优先级，执行回调，然后恢复之前的优先级
export function startTransition(scope) {
  const prevPriority = concurrency.currentPriority;
  concurrency.currentPriority = UpdatePriorities.LowPriority;
  try {
    scope();
  } finally {
    concurrency.currentPriority = prevPriority;
  }
}

// 并发控制，定义任务处理时间限制5ms和优先级阈值，确保高优先级任务优先处理同时避免长时间占用主线程
const concurrency = {
  // 新增优先级阈值
  priorityThreshold: 2,
  shouldYield() {
    return (
      performance.now() - this.startTime > 5 ||
      this.currentPriority < this.priorityThreshold
    );
  },
  startTime: 0,
};
