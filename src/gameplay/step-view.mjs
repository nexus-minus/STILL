/** Pure camera-only damping shared by the controller and its CPU check. */
export function stepViewRetention(dtSeconds, tauSeconds) {
  if (!(dtSeconds >= 0) || !(tauSeconds > 0)) {
    throw new RangeError('step view needs dt >= 0 and tau > 0');
  }
  return Math.exp(-dtSeconds / tauSeconds);
}
