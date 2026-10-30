"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_TRAINING_SAMPLES,
  normalizeFeatures,
  predictQueueMinutes,
  trainQueueModel
} = require("../queue-model");

function sample(queueMinutes, prepMinutes, targetMinutes) {
  return {
    features: {
      queueOrders: queueMinutes / 10,
      queueMinutes,
      prepMinutes,
      quantity: 1,
      staff: 1,
      rushFactor: 1,
      hour: 12,
      weekday: 2
    },
    targetMinutes
  };
}

test("queue model normalizes the eight documented input features", () => {
  assert.deepEqual(normalizeFeatures({
    queueOrders: 10,
    queueMinutes: 120,
    prepMinutes: 30,
    quantity: 10,
    staff: 5,
    rushFactor: 1,
    hour: 23,
    weekday: 3
  }), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5]);
});

test("queue model activates only after the configured amount of completed-ticket data", () => {
  const samples = Array.from({ length: MIN_TRAINING_SAMPLES - 1 }, (_, index) => sample(index, 5, 10 + index));
  assert.equal(trainQueueModel(samples, 1).ready, false);
  assert.equal(trainQueueModel([...samples, sample(8, 8, 18)], 1).ready, true);
});

test("trained neural queue regressor predicts finite waits and responds to learned workload", () => {
  const samples = [];
  for (let queueMinutes = 0; queueMinutes <= 100; queueMinutes += 10) {
    for (let prepMinutes = 5; prepMinutes <= 25; prepMinutes += 10) {
      samples.push(sample(queueMinutes, prepMinutes, Math.min(240, 4 + queueMinutes * 0.45 + prepMinutes * 1.1)));
    }
  }
  const model = trainQueueModel(samples, 3);
  const light = predictQueueMinutes(model, sample(10, 10, 0).features);
  const busy = predictQueueMinutes(model, sample(90, 20, 0).features);
  assert.ok(Number.isFinite(light));
  assert.ok(Number.isFinite(busy));
  assert.ok(light >= 0 && light <= 240);
  assert.ok(busy > light, `Expected higher-workload prediction ${busy} to exceed ${light}`);
});

