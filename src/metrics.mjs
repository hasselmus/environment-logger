export function absoluteHumidity(tempC, rhPct) {
  const t = Number(tempC), rh = Number(rhPct);
  if (!Number.isFinite(t) || !Number.isFinite(rh)) return null;
  const saturationHpa = 6.112 * Math.exp((17.62 * t) / (243.12 + t));
  return 216.7 * ((rh / 100) * saturationHpa) / (273.15 + t);
}

export function dewPoint(tempC, rhPct) {
  const t = Number(tempC), rh = Number(rhPct);
  if (!Number.isFinite(t) || !Number.isFinite(rh) || rh <= 0 || rh > 100) return null;
  const a = 17.62, b = 243.12;
  const gamma = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * gamma) / (a - gamma);
}

export const metricUnits = {
  temperature: '°C',
  relative_humidity: '%',
  absolute_humidity: 'g/m³',
  dew_point: '°C',
  probe_temperature: '°C',
  dew_margin: '°C',
  pressure: 'kPa',
  co2: 'ppm',
  pm2_5: 'µg/m³',
  pm1: 'µg/m³',
  pm4: 'µg/m³',
  pm10: 'µg/m³',
  voc_index: '',
  nox_index: '',
  air_quality: ''
};
