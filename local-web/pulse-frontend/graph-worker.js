importScripts('graph-engine.js?v=2.1.12');
const engine = PulseGraph.createEngine();
self.onmessage = ({data}) => {
  try {
    if (data.action === 'analyse') {
      self.postMessage({id: data.id, result: engine.analyse(data.payload)});
    } else if (data.action === 'layout') {
      self.postMessage({id: data.id, positions: PulseGraph.layout(data.payload)});
    } else {
      throw new Error('Unknown graph operation.');
    }
  } catch (error) {
    self.postMessage({id: data.id, error: error.message});
  }
};
