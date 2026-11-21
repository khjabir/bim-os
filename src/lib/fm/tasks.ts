// A starting library of planned maintenance tasks per asset kind.
//
// The intervals are typical starting points written for this project, to be
// reviewed by the facility team against the manufacturers' instructions, the
// local regulations and any licensed schedule they use (such as SFG20). Tasks
// marked statutory are a legal or insurance requirement in many countries;
// the exact interval depends on where the building is.

import type { TaskTemplate, Unit } from "./types";

const t = (id: string, kindCodes: string[], title: string, every: number, unit: Unit, extra: Partial<TaskTemplate> = {}): TaskTemplate => ({ id, kindCodes, title, every, unit, ...extra });

export const TASK_LIBRARY_NOTE =
  "Typical starting intervals written for bim-os. Review them against the manufacturer's instructions, local regulations and any licensed schedule you use before relying on them.";

export const DEFAULT_TASKS: TaskTemplate[] = [
  // Air handling and terminal units
  t("ahu-filters", ["AHU"], "Inspect air handling unit, change filters as needed", 3, "month", { minutes: 60, trade: "HVAC" }),
  t("ahu-service", ["AHU"], "Annual service: fans, belts, bearings, coils, drain pans, dampers", 12, "month", { minutes: 240, trade: "HVAC" }),
  t("fcu-service", ["FCU", "IDU"], "Clean or change filters, clear condensate drain", 6, "month", { minutes: 30, trade: "HVAC" }),
  t("vav-check", ["VAV"], "Check terminal unit operation, actuator and controls", 12, "month", { minutes: 30, trade: "HVAC" }),
  t("fan-inspect", ["FAN"], "Inspect fan: bearings, belts, vibration, guards", 6, "month", { minutes: 45, trade: "HVAC" }),
  t("air-curtain", ["AC"], "Clean and check air curtain", 12, "month", { minutes: 30, trade: "HVAC" }),
  t("damper-check", ["DMP"], "Exercise motorised damper, check actuator", 12, "month", { minutes: 20, trade: "HVAC" }),
  t("kitchen-hood", ["KH"], "Clean kitchen extract hood, filters and grease duct", 6, "month", { minutes: 120, trade: "HVAC", statutory: true, notes: "Interval depends on cooking use; insurers often set it." }),
  t("humidifier", ["HUM"], "Clean and disinfect humidifier, check water quality", 3, "month", { minutes: 60, trade: "HVAC" }),
  t("hex-service", ["HEX"], "Inspect heat exchanger, check for leaks and fouling", 12, "month", { minutes: 60, trade: "HVAC" }),
  t("heater-check", ["EH"], "Check electric heater, controls and safety cut-outs", 12, "month", { minutes: 20, trade: "Electrical" }),

  // Heating, cooling and refrigeration
  t("chiller-checks", ["CH"], "Operational checks: pressures, temperatures, alarms", 1, "month", { minutes: 60, trade: "HVAC" }),
  t("chiller-service", ["CH"], "Annual chiller service", 12, "month", { minutes: 480, trade: "HVAC" }),
  t("refrigerant-leak", ["CH", "HP", "CU"], "Refrigerant leak check and record", 12, "month", { minutes: 60, trade: "Refrigeration", statutory: true, notes: "The interval depends on the refrigerant charge under F-gas or equivalent rules." }),
  t("hp-service", ["HP", "CU"], "Inspect and clean heat pump / condensing unit", 6, "month", { minutes: 90, trade: "HVAC" }),
  t("cooling-tower-water", ["CT"], "Water treatment and Legionella checks", 1, "week", { minutes: 30, trade: "Water hygiene", statutory: true }),
  t("cooling-tower-clean", ["CT"], "Clean and disinfect cooling tower", 6, "month", { minutes: 480, trade: "Water hygiene", statutory: true }),
  t("boiler-service", ["BLR"], "Annual boiler service and combustion test", 12, "month", { minutes: 180, trade: "Heating", statutory: true }),
  t("pressurisation", ["PU", "EXV"], "Check pressurisation unit and expansion vessel charge", 12, "month", { minutes: 45, trade: "HVAC" }),

  // Pumps and water
  t("pump-inspect", ["PMP", "BPS", "SP"], "Inspect pump: seals, bearings, vibration, controls", 6, "month", { minutes: 45, trade: "Mechanical" }),
  t("booster-service", ["BPS"], "Service booster set, check pressure vessels and controls", 12, "month", { minutes: 120, trade: "Mechanical" }),
  t("tank-inspect", ["TNK"], "Inspect water storage tank, record temperatures", 6, "month", { minutes: 45, trade: "Water hygiene", statutory: true }),
  t("tank-clean", ["TNK"], "Clean and disinfect water storage tank", 12, "month", { minutes: 240, trade: "Water hygiene", statutory: true }),
  t("water-heater-temp", ["WH"], "Record water heater flow and return temperatures", 1, "month", { minutes: 15, trade: "Water hygiene", statutory: true }),
  t("water-heater-service", ["WH"], "Service water heater, check safety valves", 12, "month", { minutes: 90, trade: "Plumbing" }),
  t("tmv-service", ["TMV"], "Service and temperature-test thermostatic mixing valve", 12, "month", { minutes: 30, trade: "Plumbing" }),
  t("backflow-test", ["BFP"], "Test backflow preventer", 12, "month", { minutes: 45, trade: "Plumbing", statutory: true }),
  t("water-treatment", ["WT"], "Check water treatment plant and dosing", 1, "month", { minutes: 30, trade: "Water hygiene" }),
  t("strainer-clean", ["STR"], "Clean strainer", 12, "month", { minutes: 20, trade: "Mechanical" }),
  t("valve-exercise", ["VLV"], "Exercise isolating valve, check for leaks", 12, "month", { minutes: 10, trade: "Mechanical" }),
  t("fountain-filter", ["DF"], "Change filter and sanitise drinking water point", 3, "month", { minutes: 20, trade: "Plumbing" }),
  t("grease-trap", ["GT"], "Empty and clean grease separator", 3, "month", { minutes: 60, trade: "Drainage" }),
  t("fuel-tank", ["FT"], "Inspect fuel tank, bund and level gauge", 12, "month", { minutes: 45, trade: "Mechanical" }),
  t("compressor", ["AC-C"], "Service air compressor and examine pressure system", 12, "month", { minutes: 120, trade: "Mechanical", statutory: true }),

  // Electrical
  t("board-thermal", ["DB", "SMDB", "MSB", "MCC", "MVS"], "Thermographic survey of switchboard", 12, "month", { minutes: 30, trade: "Electrical" }),
  t("board-inspect", ["DB", "SMDB", "MSB", "MCC"], "Periodic inspection and testing of the installation", 5, "year", { minutes: 120, trade: "Electrical", statutory: true }),
  t("transformer", ["TX"], "Inspect transformer: oil or resin, temperatures, connections", 12, "month", { minutes: 120, trade: "Electrical" }),
  t("generator-run", ["GEN"], "Test-run generator on load, check fuel and batteries", 1, "month", { minutes: 60, trade: "Electrical" }),
  t("generator-service", ["GEN"], "Annual generator service", 12, "month", { minutes: 360, trade: "Electrical" }),
  t("ups-service", ["UPS"], "Service UPS and test batteries", 6, "month", { minutes: 120, trade: "Electrical" }),
  t("ats-test", ["ATS"], "Test automatic transfer switch", 12, "month", { minutes: 60, trade: "Electrical" }),
  t("vsd-check", ["VSD", "PFC"], "Inspect drive / capacitor bank, clean filters and fans", 12, "month", { minutes: 45, trade: "Electrical" }),
  t("ev-charger", ["EVCP"], "Inspect and test EV charger", 12, "month", { minutes: 45, trade: "Electrical" }),
  t("pv-inspect", ["PV"], "Inspect solar PV array and inverter", 12, "month", { minutes: 120, trade: "Electrical" }),
  t("lightning", ["LP"], "Inspect and test lightning protection and earthing", 12, "month", { minutes: 120, trade: "Electrical", statutory: true }),
  t("lighting-control", ["LC"], "Check lighting control system and sensors", 12, "month", { minutes: 30, trade: "Electrical" }),

  // Emergency lighting
  t("em-light-monthly", ["EL", "EX"], "Short function test of emergency light", 1, "month", { minutes: 5, trade: "Electrical", statutory: true }),
  t("em-light-annual", ["EL", "EX"], "Full rated-duration test of emergency light", 12, "month", { minutes: 10, trade: "Electrical", statutory: true }),
  t("central-battery", ["CBS"], "Test central battery system and its circuits", 12, "month", { minutes: 120, trade: "Electrical", statutory: true }),

  // Fire detection and alarm
  t("fire-alarm-weekly", ["FACP"], "Weekly fire alarm test from a call point", 1, "week", { minutes: 15, trade: "Fire", statutory: true }),
  t("fire-alarm-service", ["FACP", "VAP"], "Service fire alarm / voice alarm panel", 6, "month", { minutes: 120, trade: "Fire", statutory: true }),
  t("detector-test", ["SD", "HD", "MSD", "BD", "ASD", "DSD", "FLD", "FAD"], "Test detector", 12, "month", { minutes: 5, trade: "Fire", statutory: true }),
  t("call-point-test", ["MCP"], "Test manual call point", 12, "month", { minutes: 5, trade: "Fire", statutory: true }),
  t("sounder-test", ["SB", "VAS"], "Test sounder / beacon output", 12, "month", { minutes: 5, trade: "Fire", statutory: true }),
  t("interface-test", ["FIM"], "Test fire alarm interface and what it triggers", 12, "month", { minutes: 15, trade: "Fire", statutory: true }),
  t("refuge-test", ["EVC"], "Test refuge / emergency voice point", 6, "month", { minutes: 10, trade: "Fire", statutory: true }),
  t("gas-detector", ["GD"], "Calibrate and test gas detector", 6, "month", { minutes: 20, trade: "Fire" }),

  // Fire suppression and passive protection
  t("sprinkler-valve", ["AVS"], "Weekly sprinkler alarm valve test", 1, "week", { minutes: 20, trade: "Fire", statutory: true }),
  t("flow-switch", ["FS"], "Test flow / tamper switch", 3, "month", { minutes: 10, trade: "Fire", statutory: true }),
  t("sprinkler-heads", ["SPK"], "Visual inspection of sprinkler heads", 12, "month", { minutes: 2, trade: "Fire", statutory: true }),
  t("fire-pump-run", ["FP"], "Weekly fire pump run test", 1, "week", { minutes: 30, trade: "Fire", statutory: true }),
  t("fire-pump-service", ["FP"], "Annual fire pump service and flow test", 12, "month", { minutes: 240, trade: "Fire", statutory: true }),
  t("hose-reel", ["FHR"], "Inspect and test fire hose reel", 12, "month", { minutes: 15, trade: "Fire", statutory: true }),
  t("landing-valve", ["FH"], "Inspect landing valve / hydrant", 6, "month", { minutes: 15, trade: "Fire", statutory: true }),
  t("extinguisher", ["FE"], "Service fire extinguisher", 12, "month", { minutes: 10, trade: "Fire", statutory: true }),
  t("gas-suppression", ["GSS"], "Service gas suppression system", 6, "month", { minutes: 120, trade: "Fire", statutory: true }),
  t("fire-damper", ["FD", "SMD"], "Drop-test fire / smoke damper and reset", 12, "month", { minutes: 20, trade: "Fire", statutory: true }),
  t("smoke-vent", ["AOV"], "Test smoke vent / AOV", 12, "month", { minutes: 20, trade: "Fire", statutory: true }),
  t("fire-curtain", ["FC"], "Test fire / smoke curtain", 12, "month", { minutes: 30, trade: "Fire", statutory: true }),
  t("fire-door", ["FDR"], "Inspect fire door: closer, seals, gaps, signage", 6, "month", { minutes: 10, trade: "Fabric", statutory: true }),

  // Lifts and access equipment
  t("lift-visit", ["LFT", "ESC", "TRV"], "Routine maintenance visit", 1, "month", { minutes: 90, trade: "Lifts" }),
  t("lift-exam", ["LFT", "ESC", "TRV", "PL", "BMU"], "Thorough examination by a competent person", 6, "month", { minutes: 120, trade: "Lifts", statutory: true }),

  // Doors, security and IT
  t("auto-door", ["ADR", "RS", "GTE"], "Service automatic door / shutter / barrier and test safety devices", 6, "month", { minutes: 60, trade: "Fabric" }),
  t("cctv", ["CAM"], "Clean and check CCTV camera and recording", 12, "month", { minutes: 15, trade: "Security" }),
  t("access-control", ["ACR", "DRL", "INT"], "Test access control reader / door release", 12, "month", { minutes: 15, trade: "Security" }),
  t("intruder", ["IDS"], "Test intruder detection", 12, "month", { minutes: 10, trade: "Security" }),
  t("bms-controller", ["BMS", "CTL"], "Check controller, back up its program, test sensors", 12, "month", { minutes: 45, trade: "Controls" }),

  // Catering and specialist
  t("cold-room", ["CR"], "Service cold room refrigeration and door seals", 6, "month", { minutes: 90, trade: "Refrigeration" }),
  t("catering", ["KIT"], "Service catering equipment", 12, "month", { minutes: 60, trade: "Catering" }),
  t("medical-gas", ["MG"], "Inspect and test medical gas equipment", 12, "month", { minutes: 120, trade: "Medical gas", statutory: true }),
];

/** Kind codes the library covers. */
export function coveredKinds(tasks: TaskTemplate[]): Set<string> {
  return new Set(tasks.flatMap((task) => task.kindCodes));
}

export function tasksForKind(tasks: TaskTemplate[], kindCode: string): TaskTemplate[] {
  return tasks.filter((task) => task.kindCodes.includes(kindCode));
}

export function intervalText(every: number, unit: Unit): string {
  if (every === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit];
  if (unit === "month" && every === 3) return "Quarterly";
  if (unit === "month" && every === 6) return "Every 6 months";
  if (unit === "month" && every === 12) return "Yearly";
  return `Every ${every} ${unit}s`;
}
