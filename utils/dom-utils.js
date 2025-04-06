export function createElement(node) {
  if (typeof node === "string") {
    return document.createTextNode(node);
  }

  const element = document.createElement(node.type);

  Object.keys(node.props).forEach((propName) => {
    if (propName.startsWith("on")) {
      element.addEventListener(
        propName.toLowerCase().substring(2),
        node.props[propName]
      );
    } else {
      element[propName] = node.props[propName];
    }
  });

  node.children.forEach((child) => {
    element.appendChild(createElement(child));
  });

  return element;
}

export function updateProps(domNode, props) {
  Object.keys(props).forEach((key) => {
    if (props[key] === undefined) {
      domNode.removeAttribute(key);
    } else {
      domNode.setAttribute(key, props[key]);
    }
  });
}
