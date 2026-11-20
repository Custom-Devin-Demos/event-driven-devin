function adaptTelemetry(sample) {
  const speed = Number(sample.groundSpeedKph);
  if (!Number.isFinite(speed)) throw new Error(`Telemetry unavailable for ${sample.truckId}; autonomous operation safe-stopped`);
  return { truckId: sample.truckId, speedKph: speed };
}

module.exports = { adaptTelemetry };
