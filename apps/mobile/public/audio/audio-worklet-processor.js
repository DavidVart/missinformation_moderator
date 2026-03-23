class ModeratorAudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];

    if (!input || input.length === 0) {
      return true;
    }

    const channel = input[0];

    if (!channel || channel.length === 0) {
      return true;
    }

    this.port.postMessage(new Float32Array(channel));
    return true;
  }
}

registerProcessor("moderator-audio-processor", ModeratorAudioProcessor);
