// Revit category (+ family and type names) -> IFC4 class and PredefinedType.
//
// The family-name rules come from a pass over every family in a large arena
// model (architecture, seating, façade, MEP, signage): manholes, cubicle
// panels, cisterns, flush pipes, bidet sprays, fan-coil units, isolators,
// data cabinets, cameras, speakers, extinguishers, BWIC openings and sign
// families each had landed in the wrong class with the category alone.
// Objects without a Revit category fall back to the name-based guesser the
// NWD viewer uses.

import { guessIfcClass } from "@/lib/lmv/classify";
import { ifcClass, predefinedOk } from "./ifc/schema";

export interface IfcClassChoice {
  /** Proper-case IFC4 class, e.g. "IfcPipeSegment". */
  cls: string;
  predefined: string | null;
  /** Spaces are spatial elements (aggregated into the storey), everything else is contained. */
  spatial?: boolean;
}

type Rule = [string, string | null];

const CATEGORY: Record<string, Rule> = {
  Walls: ["IfcWall", null],
  Doors: ["IfcDoor", "DOOR"],
  Windows: ["IfcWindow", "WINDOW"],
  Floors: ["IfcSlab", "FLOOR"],
  Ceilings: ["IfcCovering", "CEILING"],
  Roofs: ["IfcRoof", null],
  "Roof Soffits": ["IfcCovering", "CLADDING"],
  Fascias: ["IfcMember", null],
  Gutters: ["IfcPipeSegment", "GUTTER"],
  Railings: ["IfcRailing", null],
  Handrails: ["IfcRailing", "HANDRAIL"],
  "Top Rails": ["IfcRailing", null],
  Stairs: ["IfcStair", null],
  Runs: ["IfcStairFlight", null],
  Landings: ["IfcSlab", "LANDING"],
  Ramps: ["IfcRamp", null],
  "Curtain Panels": ["IfcPlate", "CURTAIN_PANEL"],
  "Curtain Wall Mullions": ["IfcMember", "MULLION"],
  "Curtain Systems": ["IfcCurtainWall", null],
  "Structural Framing": ["IfcBeam", null],
  "Structural Columns": ["IfcColumn", null],
  Columns: ["IfcColumn", null],
  "Structural Stiffeners": ["IfcPlate", null],
  "Structural Connections": ["IfcBuildingElementProxy", null],
  "Structural Foundations": ["IfcFooting", null],
  "Structural Rebar": ["IfcReinforcingBar", null],
  "Structural Trusses": ["IfcMember", null],
  Supports: ["IfcMember", null],
  Furniture: ["IfcFurniture", null],
  "Furniture Systems": ["IfcFurniture", null],
  Casework: ["IfcFurniture", null],
  "Plumbing Fixtures": ["IfcSanitaryTerminal", null],
  "Plumbing Equipment": ["IfcUnitaryEquipment", null],
  "Specialty Equipment": ["IfcBuildingElementProxy", null],
  "Generic Models": ["IfcBuildingElementProxy", null],
  Parking: ["IfcBuildingElementProxy", null],
  Planting: ["IfcGeographicElement", null],
  Topography: ["IfcGeographicElement", "TERRAIN"],
  Toposolid: ["IfcGeographicElement", "TERRAIN"],
  Site: ["IfcGeographicElement", null],
  Hardscape: ["IfcSlab", null],
  "Mechanical Equipment": ["IfcUnitaryEquipment", null],
  "Mechanical Control Devices": ["IfcController", null],
  "Electrical Equipment": ["IfcElectricDistributionBoard", null],
  "Electrical Fixtures": ["IfcOutlet", null],
  "Lighting Fixtures": ["IfcLightFixture", null],
  "Lighting Devices": ["IfcSwitchingDevice", null],
  "Fire Alarm Devices": ["IfcAlarm", null],
  "Communication Devices": ["IfcCommunicationsAppliance", null],
  "Data Devices": ["IfcCommunicationsAppliance", null],
  "Security Devices": ["IfcCommunicationsAppliance", null],
  "Telephone Devices": ["IfcCommunicationsAppliance", null],
  "Nurse Call Devices": ["IfcCommunicationsAppliance", null],
  "Audio Visual Devices": ["IfcAudioVisualAppliance", null],
  "Medical Equipment": ["IfcMedicalDevice", null],
  "Food Service Equipment": ["IfcElectricAppliance", null],
  Sprinklers: ["IfcFireSuppressionTerminal", "SPRINKLER"],
  "Fire Protection": ["IfcFireSuppressionTerminal", null],
  Pipes: ["IfcPipeSegment", "RIGIDSEGMENT"],
  "Flex Pipes": ["IfcPipeSegment", "FLEXIBLESEGMENT"],
  "Pipe Fittings": ["IfcPipeFitting", null],
  "Pipe Accessories": ["IfcValve", null],
  "Pipe Insulations": ["IfcCovering", "INSULATION"],
  Ducts: ["IfcDuctSegment", "RIGIDSEGMENT"],
  "Flex Ducts": ["IfcDuctSegment", "FLEXIBLESEGMENT"],
  "Duct Fittings": ["IfcDuctFitting", null],
  "Duct Accessories": ["IfcDamper", null],
  "Duct Insulations": ["IfcCovering", "INSULATION"],
  "Duct Linings": ["IfcCovering", "INSULATION"],
  "Air Terminals": ["IfcAirTerminal", null],
  "MEP Fabrication Ductwork": ["IfcDuctSegment", null],
  "MEP Fabrication Pipework": ["IfcPipeSegment", null],
  "MEP Fabrication Hangers": ["IfcDiscreteAccessory", null],
  "MEP Fabrication Containment": ["IfcCableCarrierSegment", null],
  "MEP Ancillary Framing": ["IfcMember", null],
  "Cable Trays": ["IfcCableCarrierSegment", "CABLETRAYSEGMENT"],
  "Cable Tray Fittings": ["IfcCableCarrierFitting", null],
  Conduits: ["IfcCableCarrierSegment", "CONDUITSEGMENT"],
  "Conduit Fittings": ["IfcCableCarrierFitting", null],
  Wires: ["IfcCableSegment", "CABLESEGMENT"],
  "Slab Edges": ["IfcBuildingElementProxy", null],
  "Wall Sweeps": ["IfcBuildingElementProxy", null],
  "Vertical Circulation": ["IfcTransportElement", null],
  Parts: ["IfcBuildingElementPart", null],
  Mass: ["IfcBuildingElementProxy", null],
  Entourage: ["IfcBuildingElementProxy", null],
  Signage: ["IfcBuildingElementProxy", null],
  "Temporary Structures": ["IfcBuildingElementProxy", null],
};

const SPACE_CATEGORIES = new Set(["Rooms", "Spaces", "Areas", "MEP Spaces", "HVAC Zones"]);

/** Categories that are usually not wanted as building elements (helpers, annotations, voids). */
export const DEFAULT_EXCLUDED_CATEGORIES = new Set(["Areas", "Lines", "Model Lines", "<Room Separation>", "<Space Separation>", "<Area Boundary>", "Shaft Openings", "Openings", "Detail Items", "Mass", "Cameras", "Levels", "Grids", "Reference Planes", "Scope Boxes"]);

const word = (text: string) => text.replace(/[^a-z0-9]+/g, " ");

export function classify(category: string, family: string, type: string, extraNames: string[] = []): IfcClassChoice {
  const t = `${family} ${type}`.toLowerCase();
  const rule = CATEGORY[category];
  let cls: string;
  let pdef: string | null;
  if (rule) [cls, pdef] = rule;
  else if (SPACE_CATEGORIES.has(category)) return { cls: "IfcSpace", predefined: "INTERNAL", spatial: true };
  else {
    const guess = guessIfcClass([category, family, type, ...extraNames]);
    cls = ifcClass(guess)?.name ?? "IfcBuildingElementProxy";
    pdef = null;
  }
  const has = (w: string, ...keys: string[]) => keys.some((k) => new RegExp(`\\b${k}\\b`).test(w));
  const sub = (w: string, ...keys: string[]) => keys.some((k) => w.includes(k));
  const any = (...keys: string[]) => keys.some((k) => t.includes(k));

  if (category === "Plumbing Fixtures") {
    const w = word(t);
    if (sub(w, "manhole")) [cls, pdef] = ["IfcDistributionChamberElement", "MANHOLE"];
    else if (sub(w, "cubicle", "pnlint", "pnlext") || has(w, "partition")) [cls, pdef] = ["IfcWall", "PARTITIONING"];
    else if (has(w, "cistern", "conceala")) pdef = "CISTERN";
    else if (has(w, "faucet", "mixer", "tap", "faucets")) [cls, pdef] = ["IfcValve", "FAUCET"];
    else if (has(w, "flush pipe")) [cls, pdef] = ["IfcPipeSegment", "RIGIDSEGMENT"];
    else if (has(w, "flush")) [cls, pdef] = ["IfcValve", "FLUSHING"];
    else if (sub(w, "roof drain", "roofdrain")) [cls, pdef] = ["IfcWasteTerminal", "ROOFDRAIN"];
    else if (sub(w, "gully")) [cls, pdef] = ["IfcWasteTerminal", "GULLYTRAP"];
    else if (sub(w, "drain", "floor waste")) [cls, pdef] = ["IfcWasteTerminal", "FLOORWASTE"];
    else if (has(w, "trap", "bottletrap")) [cls, pdef] = ["IfcWasteTerminal", "WASTETRAP"];
    else if (has(w, "grab", "rail", "dispenser", "dryer", "mirror", "holder", "bin", "hook", "shelf", "soap", "paper", "towel", "napkin", "baby")) [cls, pdef] = ["IfcFurniture", null];
    else {
      const table: [string[], string][] = [
        [["shattaf", "bidet spray", "toilet spray"], "USERDEFINED"],
        [["seat and cover", "wc seat", "toilet seat"], "WCSEAT"],
        [["bidet"], "BIDET"],
        [["urinal"], "URINAL"],
        [["wc", "toilet", "water closet", "pan", "closet"], "TOILETPAN"],
        [["basin", "lavatory", "vanity", "washbasin", "whb"], "WASHHANDBASIN"],
        [["sink"], "SINK"],
        [["shower"], "SHOWER"],
        [["bath", "bathtub"], "BATH"],
        [["fountain", "drinking"], "SANITARYFOUNTAIN"],
      ];
      for (const [keys, value] of table) {
        if (has(w, ...keys) || (value === "SANITARYFOUNTAIN" && sub(w, "fountain"))) {
          pdef = value;
          break;
        }
      }
    }
  } else if (category === "Furniture" && any("seat", "chair", "stool", "sofa", "bench")) pdef = "CHAIR";
  else if ((category === "Furniture" || category === "Casework") && any("desk", "workstation", "table", "counter")) pdef = t.includes("table") ? "TABLE" : "DESK";
  else if ((category === "Furniture" || category === "Casework") && any("locker", "cabinet", "storage", "shelf", "shoe")) pdef = "SHELF";
  else if (category === "Mechanical Equipment" || category === "Plumbing Equipment") {
    const table: [string, string, string | null][] = [
      ["fan coil", "IfcUnitaryEquipment", "USERDEFINED"],
      ["fancoil", "IfcUnitaryEquipment", "USERDEFINED"],
      ["fcu", "IfcUnitaryEquipment", "USERDEFINED"],
      ["chilled beam", "IfcAirTerminal", null],
      ["opening", "IfcBuildingElementProxy", "PROVISIONFORVOID"],
      ["extinguisher", "IfcFireSuppressionTerminal", "USERDEFINED"],
      ["hose reel", "IfcFireSuppressionTerminal", "HOSEREEL"],
      ["fhc", "IfcFireSuppressionTerminal", "HOSEREEL"],
      ["cylinder", "IfcTank", "PRESSUREVESSEL"],
      ["water heater", "IfcElectricAppliance", "FREESTANDINGWATERHEATER"],
      ["waterheater", "IfcElectricAppliance", "FREESTANDINGWATERHEATER"],
      ["smoke curtain", "IfcBuildingElementProxy", null],
      ["strut", "IfcBuildingElementProxy", null],
      ["plenum", "IfcDuctFitting", null],
      ["pump", "IfcPump", null],
      ["fan", "IfcFan", null],
      ["tank", "IfcTank", null],
      ["chiller", "IfcChiller", null],
      ["boiler", "IfcBoiler", null],
      ["heater", "IfcElectricAppliance", null],
      ["heat exchanger", "IfcHeatExchanger", null],
      ["ahu", "IfcUnitaryEquipment", "AIRHANDLER"],
      ["air handling", "IfcUnitaryEquipment", "AIRHANDLER"],
      ["lift", "IfcTransportElement", "ELEVATOR"],
      ["elevator", "IfcTransportElement", "ELEVATOR"],
      ["escalator", "IfcTransportElement", "ESCALATOR"],
      ["beam", "IfcBeam", null],
      ["bed plate", "IfcPlate", null],
    ];
    for (const [k, c2, p2] of table) {
      if (t.includes(k)) {
        [cls, pdef] = [c2, p2];
        break;
      }
    }
  } else if (category === "Electrical Equipment") {
    if (any("transformer", "trafo")) [cls, pdef] = ["IfcTransformer", "VOLTAGE"];
    else if (any("photovoltaic inverter", "pv inverter", "solar inverter")) [cls, pdef] = ["IfcTransformer", "INVERTER"];
    else if (any("generator", "genset", "gen set")) [cls, pdef] = ["IfcElectricGenerator", any("diesel", "engine", "genset", "gen set") ? "ENGINEGENERATOR" : null];
    else if (has(t, "ups") || any("uninterruptible")) [cls, pdef] = ["IfcElectricFlowStorageDevice", "UPS"];
    else if (any("capacitor bank", "power factor")) [cls, pdef] = ["IfcElectricFlowStorageDevice", "CAPACITORBANK"];
    else if (any("battery", "batteries")) [cls, pdef] = ["IfcElectricFlowStorageDevice", "BATTERY"];
    else if (any("busbar", "bus bar", "busduct", "bus duct", "busway")) [cls, pdef] = ["IfcCableSegment", "BUSBARSEGMENT"];
    else if (any("energy meter", "kwh meter", "electricity meter", "power meter")) [cls, pdef] = ["IfcFlowMeter", "ENERGYMETER"];
    else if (any("isolator", "disconnector")) [cls, pdef] = ["IfcSwitchingDevice", "SWITCHDISCONNECTOR"];
    else if (any("data_cabinet", "data cabinet", "rack")) [cls, pdef] = ["IfcCommunicationsAppliance", null];
    else if (any("switchboard", "switchgear")) pdef = "SWITCHBOARD";
    else if (any("distributionboard", "distribution board")) pdef = "DISTRIBUTIONBOARD";
    else if (any("motor control", "mcc")) pdef = "MOTORCONTROLCENTRE";
  } else if (category === "Fire Alarm Devices") {
    if (t.includes("smoke")) [cls, pdef] = ["IfcSensor", "SMOKESENSOR"];
    else if (t.includes("heat")) [cls, pdef] = ["IfcSensor", "HEATSENSOR"];
    else if (any("detector", "sensor")) [cls, pdef] = ["IfcSensor", null];
    else if (any("button", "call point", "callpoint", "break glass", "breakglass")) pdef = "BREAKGLASSBUTTON";
    else if (any("strobe", "beacon", "signal lamp", "signallamp")) pdef = "LIGHT";
    else if (any("sounder", "siren", "horn")) pdef = "SIREN";
    else if (t.includes("bell")) pdef = "BELL";
    else if (t.includes("telephone")) [cls, pdef] = ["IfcAudioVisualAppliance", "TELEPHONE"];
    else if (t.includes("access panel")) [cls, pdef] = ["IfcBuildingElementProxy", null];
  } else if (category === "Lighting Devices") {
    if (any("occupan", "presence", "motion", "sensor")) [cls, pdef] = ["IfcSensor", "MOVEMENTSENSOR"];
    else if (t.includes("switch")) pdef = "TOGGLESWITCH";
  } else if (category === "Electrical Fixtures" && any("socket", "outlet", "connection unit", "connectionunit", "spur")) pdef = "POWEROUTLET";
  else if (category === "Data Devices" && t.includes("outlet")) [cls, pdef] = ["IfcOutlet", "DATAOUTLET"];
  else if (category === "Security Devices" && t.includes("camera")) [cls, pdef] = ["IfcAudioVisualAppliance", "CAMERA"];
  else if (category === "Security Devices" && t.includes("card reader")) [cls, pdef] = ["IfcSensor", "IDENTIFIERSENSOR"];
  else if (category === "Communication Devices" && any("speaker", "loudspeaker")) [cls, pdef] = ["IfcAudioVisualAppliance", "SPEAKER"];
  else if (category === "Communication Devices" && t.includes("telephone")) [cls, pdef] = ["IfcAudioVisualAppliance", "TELEPHONE"];
  else if (category === "Lighting Fixtures" && any("emergency", "exit")) pdef = "SECURITYLIGHTING";
  else if (category === "Air Terminals") {
    for (const [k, p2] of [["diffuser", "DIFFUSER"], ["grille", "GRILLE"], ["louvre", "LOUVRE"], ["louver", "LOUVRE"], ["register", "REGISTER"]]) {
      if (t.includes(k)) {
        pdef = p2;
        break;
      }
    }
  } else if ((category === "Pipe Accessories" || category === "Generic Models") && (category === "Pipe Accessories" || t.includes("valve"))) {
    if (t.includes("breeching")) [cls, pdef] = ["IfcFireSuppressionTerminal", "BREECHINGINLET"];
    else if (t.includes("hydrant")) [cls, pdef] = ["IfcFireSuppressionTerminal", "FIREHYDRANT"];
    else if (/\bmeters?\b|flowmeter|watermeter/.test(t)) [cls, pdef] = ["IfcFlowMeter", null]; // not 'diameter'
    else if (any("air release", "air vent", "air admittance")) [cls, pdef] = ["IfcValve", "AIRRELEASE"];
    else if (!any("valve", "cock", "vlv", "check", "prv", "damper")) [cls, pdef] = ["IfcPipeFitting", null];
    else {
      cls = "IfcValve";
      pdef = null;
      const table: [string, string][] = [
        ["check", "CHECK"],
        ["non return", "CHECK"],
        ["non-return", "CHECK"],
        ["prv", "PRESSUREREDUCING"],
        ["pressure reducing", "PRESSUREREDUCING"],
        ["pressure relief", "PRESSURERELIEF"],
        ["butterfly", "ISOLATING"],
        ["gate", "ISOLATING"],
        ["ball", "ISOLATING"],
        ["isolat", "ISOLATING"],
        ["balancing", "COMMISSIONING"],
        ["commissioning", "COMMISSIONING"],
        ["regulating", "REGULATING"],
        ["mixing", "MIXING"],
      ];
      for (const [k, p2] of table) {
        if (t.includes(k)) {
          pdef = p2;
          break;
        }
      }
    }
  } else if (category === "Duct Accessories") {
    if (any("silencer", "attenuator")) cls = "IfcDuctSilencer";
    else if (!t.includes("damper") && !t.includes("dmp")) cls = "IfcDuctFitting";
    else if (t.includes("fire") && t.includes("smoke")) pdef = "FIRESMOKEDAMPER";
    else if (t.includes("fire")) pdef = "FIREDAMPER";
    else if (t.includes("smoke")) pdef = "SMOKEDAMPER";
    else if (any("volume", "vcd", "balancing")) pdef = "BALANCINGDAMPER";
    else if (any("backdraft", "non return", "non-return")) pdef = "BACKDRAFTDAMPER";
    else if (any("motor", "control", "modulating")) pdef = "CONTROLDAMPER";
  } else if (category === "Generic Models" && any("sleeve", "cut-out", "cutout")) [cls, pdef] = ["IfcBuildingElementProxy", "PROVISIONFORVOID"];
  else if (category === "Generic Models" && t.includes("escalator")) [cls, pdef] = ["IfcTransportElement", "ESCALATOR"];
  else if (category === "Generic Models" && any("lift", "elevator")) [cls, pdef] = ["IfcTransportElement", "ELEVATOR"];
  else if (category === "Generic Models" && any("louver", "louvre")) [cls, pdef] = ["IfcShadingDevice", "JALOUSIE"];
  else if (category === "Specialty Equipment" && /^[a-z]\d+(\.\d+)?\s*-/.test(family.toLowerCase()) && !any("video", "screen", "display")) {
    // sign families named by sign type (C12 -, F3 -, Z20.2 - …) stay proxies
  } else if (category === "Specialty Equipment" && any("led", "display", "video", "screen")) [cls, pdef] = ["IfcAudioVisualAppliance", "DISPLAY"];
  else if (category === "Specialty Equipment" && t.includes("hose reel")) [cls, pdef] = ["IfcFireSuppressionTerminal", "HOSEREEL"];
  else if (category === "Vertical Circulation") {
    if (t.includes("escalator")) pdef = "ESCALATOR";
    else if (any("walkway", "travelator")) pdef = "MOVINGWALKWAY";
    else if (any("lift", "elevator")) pdef = "ELEVATOR";
  }

  if (!ifcClass(cls)) cls = "IfcBuildingElementProxy";
  if (!predefinedOk(cls, pdef)) pdef = null;
  return { cls, predefined: pdef };
}
