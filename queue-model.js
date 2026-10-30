"use strict";

const INPUT_COUNT = 8;
const HIDDEN_COUNT = 8;
const MIN_TRAINING_SAMPLES = 8;
const MAX_TRAINING_SAMPLES = 300;
const MAX_WAIT_MINUTES = 240;

function normalizeFeatures(features) {
  return [
    Math.min(1, Math.max(0, Number(features.queueOrders) / 20)),
    Math.min(1, Math.max(0, Number(features.queueMinutes) / MAX_WAIT_MINUTES)),
    Math.min(1, Math.max(0, Number(features.prepMinutes) / 60)),
    Math.min(1, Math.max(0, Number(features.quantity) / 20)),
    Math.min(1, Math.max(0, Number(features.staff) / 10)),
    Math.min(1, Math.max(0, Number(features.rushFactor) / 2)),
    Math.min(1, Math.max(0, Number(features.hour) / 23)),
    Math.min(1, Math.max(0, Number(features.weekday) / 6))
  ];
}

function initialWeights(seed, samples) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const targets = samples.map(sample => Math.min(MAX_WAIT_MINUTES, Math.max(0, sample.targetMinutes)) / MAX_WAIT_MINUTES);
  return {
    inputWeights: Array.from({ length: HIDDEN_COUNT }, () =>
      Array.from({ length: INPUT_COUNT }, () => (random() * 2 - 1) * 0.25)),
    hiddenBias: Array(HIDDEN_COUNT).fill(0.05),
    outputWeights: Array.from({ length: HIDDEN_COUNT }, () => (random() * 2 - 1) * 0.05),
    outputBias: targets.reduce((sum, value) => sum + value, 0) / targets.length
  };
}

function forward(model, input) {
  const hidden = model.inputWeights.map((weights, index) =>
    Math.max(0, weights.reduce((sum, weight, featureIndex) => sum + weight * input[featureIndex], model.hiddenBias[index])));
  const output = model.outputWeights.reduce((sum, weight, index) => sum + weight * hidden[index], model.outputBias);
  return { hidden, output };
}

function trainQueueModel(samples, station = 1) {
  const validSamples = samples.slice(-MAX_TRAINING_SAMPLES).filter(sample =>
    sample.features && Number.isFinite(Number(sample.targetMinutes)) && Number(sample.targetMinutes) >= 0
  );
  if (!validSamples.length) throw new Error("At least one valid queue training sample is required.");

  const trainingData = validSamples.map(sample => ({
    input: normalizeFeatures(sample.features),
    target: Math.min(MAX_WAIT_MINUTES, Number(sample.targetMinutes)) / MAX_WAIT_MINUTES
  }));
  const model = initialWeights(station * 7919 + validSamples.length * 104729, validSamples);
  const learningRate = 0.035;

  for (let epoch = 0; epoch < 280; epoch++) {
    const inputGradient = Array.from({ length: HIDDEN_COUNT }, () => Array(INPUT_COUNT).fill(0));
    const hiddenGradient = Array(HIDDEN_COUNT).fill(0);
    const outputGradient = Array(HIDDEN_COUNT).fill(0);
    let outputBiasGradient = 0;

    for (const sample of trainingData) {
      const { hidden, output } = forward(model, sample.input);
      const error = output - sample.target;
      outputBiasGradient += error;
      for (let hiddenIndex = 0; hiddenIndex < HIDDEN_COUNT; hiddenIndex++) {
        outputGradient[hiddenIndex] += error * hidden[hiddenIndex];
        if (hidden[hiddenIndex] > 0) {
          const gradient = error * model.outputWeights[hiddenIndex];
          hiddenGradient[hiddenIndex] += gradient;
          for (let featureIndex = 0; featureIndex < INPUT_COUNT; featureIndex++) {
            inputGradient[hiddenIndex][featureIndex] += gradient * sample.input[featureIndex];
          }
        }
      }
    }

    const scale = learningRate / trainingData.length;
    model.outputBias -= outputBiasGradient * scale;
    for (let hiddenIndex = 0; hiddenIndex < HIDDEN_COUNT; hiddenIndex++) {
      model.hiddenBias[hiddenIndex] -= hiddenGradient[hiddenIndex] * scale;
      model.outputWeights[hiddenIndex] -= outputGradient[hiddenIndex] * scale;
      for (let featureIndex = 0; featureIndex < INPUT_COUNT; featureIndex++) {
        model.inputWeights[hiddenIndex][featureIndex] -= inputGradient[hiddenIndex][featureIndex] * scale;
      }
    }
  }

  const typicalPrepMinutes = validSamples.reduce((sum, sample) => sum + Number(sample.features.prepMinutes || 0), 0) / validSamples.length;
  const typicalQuantity = validSamples.reduce((sum, sample) => sum + Number(sample.features.quantity || 1), 0) / validSamples.length;
  return {
    ...model,
    sampleCount: validSamples.length,
    typicalPrepMinutes,
    typicalQuantity,
    ready: validSamples.length >= MIN_TRAINING_SAMPLES
  };
}

function predictQueueMinutes(model, features) {
  if (!model?.inputWeights || !model?.outputWeights) throw new Error("A trained queue model is required.");
  const input = normalizeFeatures(features);
  const normalized = forward(model, input).output;
  return Math.min(MAX_WAIT_MINUTES, Math.max(0, normalized * MAX_WAIT_MINUTES));
}

module.exports = {
  MAX_TRAINING_SAMPLES,
  MIN_TRAINING_SAMPLES,
  normalizeFeatures,
  predictQueueMinutes,
  trainQueueModel
};
