// What an asset is, for asset management: a kind ("Air handling unit",
// "Distribution board", "Smoke detector"), a short code for asset codes
// ("AHU", "DB", "SD"), its discipline, the compliance regime it usually falls
// under, and a suggested Uniclass 2015 product (Pr) code.
//
// Kinds are recognised from the Revit category, family, type and name. The
// first matching rule wins, so specific kinds come before general ones
// (fan coil before fan, fire pump before pump, emergency light before light).
//
// Uniclass 2015 codes and titles: NBS, from the published Pr and Ss tables
// (January 2022 edition). NBS publishes Uniclass free of charge. The codes are
// suggestions for items the model does not classify; a classification in the
// model always wins.

export type Discipline = "HVAC" | "Electrical" | "Fire & life safety" | "Plumbing" | "Low voltage" | "Vertical transport" | "Architectural" | "Specialist";

/** Traits that decide which technical fields apply to an asset. */
export type Trait =
  | "air"
  | "water"
  | "refrigerant"
  | "board"
  | "source"
  | "power"
  | "lighting"
  | "emergency"
  | "fireAlarm"
  | "sprinkler"
  | "damper"
  | "extinguisher"
  | "door"
  | "lift"
  | "tank"
  | "pump"
  | "signal";

export interface AssetKind {
  id: string;
  label: string;
  /** Short code used in asset codes. */
  code: string;
  discipline: Discipline;
  /** Compliance regime usually applying (a suggestion, to be confirmed). */
  compliance: string;
  /** Suggested Uniclass 2015 Pr code and title. */
  uniclass: [string, string] | null;
  traits: Trait[];
}

interface Rule extends AssetKind {
  /** Tested on "family type name" (lower case, CamelCase and underscores split into words). */
  match?: RegExp;
  /** Revit categories the rule is limited to. */
  categories?: string[];
  /** Revit categories the rule never applies to. */
  notCategories?: string[];
}

const FIRE = "Fire safety";
const EMERGENCY = "Emergency lighting";
const LIFTING = "Lifting equipment";
const PRESSURE = "Pressure systems";
const WATER = "Water hygiene";
const FGAS = "Refrigerant (F-gas)";
const ELECTRICAL = "Electrical safety";
const GAS = "Gas safety";

const k = (id: string, label: string, code: string, discipline: Discipline, uniclass: [string, string] | null, traits: Trait[], compliance = "", extra: Partial<Rule> = {}): Rule => ({
  id,
  label,
  code,
  discipline,
  uniclass,
  traits,
  compliance,
  ...extra,
});

const MECH = ["Mechanical Equipment", "Plumbing Equipment", "Specialty Equipment"];
const ELEC_EQ = ["Electrical Equipment"];
// Wiring accessories are named after what they feed ("Fused spur - Water Heater"): never a water heater.
const ACCESSORIES = ["Electrical Fixtures", "Lighting Devices", "Data Devices", "Communication Devices", "Telephone Devices", "Security Devices", "Nurse Call Devices"];

// Order matters: the first match wins.
const RULES: Rule[] = [
  // Wiring accessories first, by what they are rather than what they feed
  k("fused-spur", "Fused connection unit", "FCU-E", "Electrical", ["Pr_65_72_97_31", "Fused connection units"], ["power"], "", { match: /fused (spur|connection)|connection unit|\bfcu\b|flex outlet|cooker (control|outlet)|switched fused|unswitched fused/, categories: ["Electrical Fixtures", "Lighting Devices"] }),
  k("isolator", "Isolator", "ISO", "Electrical", ["Pr_60_70_48_47", "Low-voltage switch-disconnectors"], ["power"], ELECTRICAL, { match: /isolator|isolating switch|disconnect|\bdp switch\b|\btp switch\b|switch[- ]?disconnector|fused switch|fireman'?s switch/, categories: ["Electrical Fixtures", "Electrical Equipment", "Lighting Devices"] }),
  k("socket", "Socket outlet", "SO", "Electrical", ["Pr_65_72_97_84", "Standard socket outlets"], ["power"], "", { match: /socket|receptacle|power outlet|\bgpo\b|\bsso\b|\bdso\b|floor box|power pole|power point/, categories: ["Electrical Fixtures", "Lighting Devices"] }),
  k("earthing", "Earthing / lightning protection", "LP", "Electrical", ["Pr_65_70_46", "Lightning protection and earthing components"], [], ELECTRICAL, { match: /earth(ing)? (pit|bar|rail|electrode|rod|component|terminal|pi)|earthing|lightning|air terminal rod|\bmet\b/, categories: ["Electrical Fixtures", "Electrical Equipment", "Generic Models", "Specialty Equipment"] }),
  k("access-panel", "Access panel", "AP", "Architectural", null, [], "", { match: /access (panel|hatch|door)|inspection (panel|hatch)/, notCategories: ["Doors"] }),
  k("disabled-alarm", "Disabled toilet alarm", "DTA", "Low voltage", ["Pr_75_75_04", "Emergency call and nurse call devices and control equipment"], ["signal"], "", { match: /disabled (alarm|toilet|refuge)? ?(alarm|pull|reset|panel|call)|pull ?cord|assistance alarm|accessible toilet alarm/ }),

  // Fire & life safety (before HVAC and plumbing, which share words such as damper, pump, valve)
  k("fire-alarm-panel", "Fire alarm panel", "FACP", "Fire & life safety", ["Pr_75_80_30_29", "Fire alarm panels"], ["fireAlarm", "board"], FIRE, { match: /fire alarm (control )?panel|\bfacp\b|fire (detection )?panel|\bfire control panel\b|fire alarm repeater|repeater panel|graphic(al)? panel|fire alarm cie|\bcie\b/ }),
  k("voice-alarm-panel", "Voice alarm panel", "VAP", "Fire & life safety", ["Pr_75_80_30_98", "Voice alarm control panels"], ["fireAlarm", "board"], FIRE, { match: /voice alarm (control )?panel|\bpava\b.*rack|\bva rack\b|\bevac (rack|panel)\b/ }),
  k("aspirating-detector", "Aspirating smoke detector", "ASD", "Fire & life safety", ["Pr_75_80_30_03", "Aspirating smoke detectors"], ["fireAlarm"], FIRE, { match: /aspirat|vesda|\basd\b/ }),
  k("beam-detector", "Beam smoke detector", "BD", "Fire & life safety", ["Pr_75_80_30_59", "Optical beam smoke detectors"], ["fireAlarm"], FIRE, { match: /beam (smoke )?detector|optical beam|reflective beam/ }),
  k("duct-detector", "Duct smoke detector", "DSD", "Fire & life safety", ["Pr_75_80_30_22", "Duct smoke detectors"], ["fireAlarm"], FIRE, { match: /duct (smoke )?detector|duct probe|duct sampling/ }),
  k("multi-sensor", "Multi-sensor detector", "MSD", "Fire & life safety", ["Pr_75_80_30_55", "Multi-sensor detectors"], ["fireAlarm"], FIRE, { match: /multi[- ]?sensor|multisensor|smoke and heat|smoke\/heat|combined smoke/ }),
  k("heat-detector", "Heat detector", "HD", "Fire & life safety", ["Pr_75_80_30_64", "Point heat detectors"], ["fireAlarm"], FIRE, { match: /heat detector|rate[- ]of[- ]rise|fixed temperature detector|thermal detector|\bror\b|linear heat/ }),
  k("smoke-detector", "Smoke detector", "SD", "Fire & life safety", ["Pr_75_80_30_65", "Point smoke detectors"], ["fireAlarm"], FIRE, { match: /smoke detector|optical (smoke )?detector|photo[- ]?electric|ionisation|ionization|smoke sensor|smoke head|\bdetector\b|\bsd\b|\bosd\b/, categories: ["Fire Alarm Devices", "Security Devices", "Mechanical Control Devices"] }),
  k("flame-detector", "Flame detector", "FLD", "Fire & life safety", ["Pr_75_80_30_63", "Point flame detectors"], ["fireAlarm"], FIRE, { match: /flame detector|\buv\/ir\b/ }),
  k("call-point", "Manual call point", "MCP", "Fire & life safety", ["Pr_75_80_30_50", "Manual call points"], ["fireAlarm"], FIRE, { match: /call point|break ?glass|pull station|\bmcp\b|manual (fire )?alarm|alarm button|fire button/, notCategories: ACCESSORIES.filter((c) => c !== "Security Devices") }),
  k("sounder-beacon", "Sounder / beacon", "SB", "Fire & life safety", ["Pr_75_80_30_30", "Fire alarm sounders"], ["fireAlarm"], FIRE, { match: /sounder|beacon|strobe|\bhorn\b|\bbell\b|visual alarm|\bvad\b|speaker[- ]strobe|siren|flasher|signal lamp/, categories: ["Fire Alarm Devices", "Communication Devices", "Security Devices"] }),
  k("fire-interface", "Fire alarm interface module", "FIM", "Fire & life safety", ["Pr_75_80_30_28", "Fire alarm input and output modules"], ["fireAlarm"], FIRE, { match: /module|interface|input[- ]?output|\bi\/o\b|\bcm\/mm\b|\bmm\b|\bcm\b|monitor(ing)? unit|relay|isolator/, categories: ["Fire Alarm Devices"] }),
  k("voice-alarm-speaker", "Voice alarm loudspeaker", "VAS", "Fire & life safety", ["Pr_75_75_94_15", "Ceiling-mounted voice alarm loudspeakers"], ["fireAlarm"], FIRE, { match: /voice alarm|\bva\b.*speaker|\bpava\b|evacuation speaker/ }),
  k("refuge-call", "Refuge / emergency voice point", "EVC", "Fire & life safety", ["Pr_75_75_94_76", "Refuge point outstations"], ["fireAlarm"], FIRE, { match: /refuge|\bevc\b|emergency voice|fire ?(fighter|man)?'?s? telephone|fire phone/ }),
  k("fire-alarm-device", "Fire alarm device", "FAD", "Fire & life safety", ["Pr_75_80_30", "Fire detection and alarm devices and control equipment"], ["fireAlarm"], FIRE, { categories: ["Fire Alarm Devices"] }),
  k("fire-damper", "Fire damper", "FD", "Fire & life safety", ["Pr_65_65_24_30", "Fire dampers"], ["damper", "air"], FIRE, { match: /fire( and smoke| ?\/ ?smoke)? damper|\bf(s)?d\b|fire rated damper|intumescent damper|\bcfsd\b|\bfsd\b/, categories: ["Duct Accessories", "Mechanical Equipment", "Specialty Equipment", "Generic Models", "Air Terminals"] }),
  k("smoke-damper", "Smoke damper", "SMD", "Fire & life safety", ["Pr_65_65_24_80", "Smoke dampers"], ["damper", "air"], FIRE, { match: /smoke damper|smoke control damper|\bsmd\b/, categories: ["Duct Accessories", "Mechanical Equipment", "Specialty Equipment", "Generic Models", "Air Terminals"] }),
  k("sprinkler-head", "Sprinkler head", "SPK", "Fire & life safety", ["Pr_70_55_97_84", "Sprinkler heads"], ["sprinkler", "water"], FIRE, { categories: ["Sprinklers"] }),
  k("alarm-valve", "Sprinkler alarm valve set", "AVS", "Fire & life safety", ["Pr_65_54_30_85", "Sprinkler system alarm valves"], ["sprinkler", "water"], FIRE, { match: /alarm valve|valve set|installation valve|wet alarm|dry alarm|deluge valve|pre-?action valve|\bavs\b|control valve set|riser (check|control) valve/ }),
  k("flow-switch", "Flow / tamper switch", "FS", "Fire & life safety", null, ["sprinkler", "water"], FIRE, { match: /flow switch|flow detector|water flow (indicator|alarm)|tamper switch|supervisory switch|monitored valve|zone (control|check) valve|\bzcv\b/ }),
  k("fire-pump", "Fire pump", "FP", "Fire & life safety", null, ["pump", "water"], FIRE, { match: /fire (fighting )?pump|sprinkler pump|jockey pump|hydrant pump|fire pump set|electric fire pump|diesel fire pump/, notCategories: ACCESSORIES }),
  k("hose-reel", "Fire hose reel", "FHR", "Fire & life safety", ["Pr_65_52_38_30", "Fire hose reels"], ["water"], FIRE, { match: /hose reel|\bfhr\b|fire hose|hose cabinet|fire cabinet|\bfhc\b/, notCategories: ACCESSORIES }),
  k("landing-valve", "Landing valve / hydrant", "FH", "Fire & life safety", ["Pr_65_54_30_97", "Wet riser landing valves"], ["water"], FIRE, { match: /landing valve|hydrant|breeching|fire department connection|\bfdc\b|siamese|dry riser|wet riser|fire brigade inlet/, notCategories: ACCESSORIES }),
  k("extinguisher", "Fire extinguisher", "FE", "Fire & life safety", ["Pr_40_50_28_64", "Portable fire extinguishers"], ["extinguisher"], FIRE, { match: /extinguisher|fire blanket|\bfe\b.*(co2|powder|foam)/, notCategories: ACCESSORIES }),
  k("gas-suppression", "Gas suppression", "GSS", "Fire & life safety", ["Pr_65_54_30_34", "Gas fire suppression manifolds"], [], FIRE, { match: /fm[- ]?200|novec|inergen|argonite|gas suppression|clean agent|co2 (suppression|system|cylinder)|suppression cylinder/, notCategories: ACCESSORIES }),
  k("smoke-vent", "Smoke vent / AOV", "AOV", "Fire & life safety", ["Pr_70_65_04_56", "Natural smoke and heat exhaust ventilators"], ["air"], FIRE, { match: /smoke vent|\baov\b|automatic opening vent|smoke (and heat )?exhaust ventilator|smoke hatch/, notCategories: ACCESSORIES }),
  k("fire-curtain", "Fire / smoke curtain", "FC", "Fire & life safety", ["Pr_25_80_79_94", "Vertical active fire curtain barriers"], [], FIRE, { match: /fire curtain|smoke curtain|fire shutter|fire-resisting shutter|smoke barrier/, notCategories: ACCESSORIES }),

  // Vertical transport
  k("escalator", "Escalator", "ESC", "Vertical transport", ["Pr_65_80_28_21", "Escalators"], ["lift", "power"], LIFTING, { match: /escalator/ }),
  k("moving-walk", "Moving walk", "TRV", "Vertical transport", ["Pr_65_80_28_52", "Moving walks"], ["lift", "power"], LIFTING, { match: /travelator|moving walk|passenger conveyor|autowalk/ }),
  k("platform-lift", "Platform lift", "PL", "Vertical transport", ["Pr_65_80_42_64", "Platform lifts"], ["lift", "power"], LIFTING, { match: /platform lift|stair ?lift|wheelchair lift|step lift/ }),
  k("bmu", "Building maintenance unit", "BMU", "Vertical transport", ["Pr_40_70_75_01", "Access cradles"], ["lift", "power"], LIFTING, { match: /\bbmu\b|gondola|building maintenance unit|window cleaning|access cradle|davit/ }),
  k("lift-part", "Lift component", "LFT-C", "Vertical transport", null, ["lift"], LIFTING, { match: /\bkone\b|\botis\b|schindler|thyssen|tk elevator|\bcwt\b|counterweight|guide ?rail|lift (car|machine|buffer|door|pit|motor|controller)|car (door|frame|sling)|landing door|\bldo\b|machine room|traction machine|buffer/, categories: ["Specialty Equipment", "Generic Models", "Mechanical Equipment"] }),
  k("lift", "Lift", "LFT", "Vertical transport", null, ["lift", "power"], LIFTING, { match: /\blift\b|elevator|dumb ?waiter|goods hoist|car lift/, categories: ["Vertical Circulation", "Specialty Equipment", "Generic Models", "Mechanical Equipment"] }),
  k("vertical-transport", "Vertical transport", "VT", "Vertical transport", null, ["lift", "power"], LIFTING, { categories: ["Vertical Circulation"] }),

  // Electrical: sources and distribution
  k("transformer", "Transformer", "TX", "Electrical", ["Pr_60_70_36_24", "High-voltage dry-type transformers"], ["board", "source", "power"], ELECTRICAL, { match: /transformer|\btx\b|\btrafo\b/, categories: [...ELEC_EQ, "Specialty Equipment", "Generic Models"] }),
  k("generator", "Generator", "GEN", "Electrical", ["Pr_60_70_65_34", "Generator sets"], ["board", "source", "power"], ELECTRICAL, { match: /generator|genset|gen set|\bdg\b|diesel engine/, categories: [...ELEC_EQ, ...MECH, "Generic Models"] }),
  k("ups", "UPS", "UPS", "Electrical", ["Pr_60_70_64_93", "Uninterruptible power supply (UPS) units"], ["board", "source", "power"], ELECTRICAL, { match: /\bups\b|uninterrupt/ }),
  k("central-battery", "Central battery unit", "CBS", "Electrical", ["Pr_60_70_06_12", "Central battery supply units"], ["board", "source", "power", "emergency"], EMERGENCY, { match: /central battery|cbs\b|battery (unit|system|cabinet)|emergency lighting (control|inverter)/ }),
  k("ats", "Transfer switch", "ATS", "Electrical", ["Pr_60_70_48_05", "Automatic transfer switching equipment (TSE)"], ["board", "power"], ELECTRICAL, { match: /\bats\b|transfer switch|changeover|\bmts\b|\bco switch/ }),
  k("mv-switchgear", "MV switchgear", "MVS", "Electrical", ["Pr_60_70_36", "High-voltage switchgear and transformers"], ["board", "source", "power"], ELECTRICAL, { match: /\brmu\b|ring main|\bmv\b|\bhv\b|medium voltage|high voltage|11 ?kv|33 ?kv|22 ?kv/, categories: ELEC_EQ }),
  k("sub-main-board", "Sub-main distribution board", "SMDB", "Electrical", ["Pr_60_70_22_22", "Distribution boards"], ["board", "power"], ELECTRICAL, { match: /\bsmdb\b|\bsdb\b|\besmdb\b|\bsmb\b|sub[- ]?main|sub[- ]?distribution/ }),
  k("main-switchboard", "Main switchboard", "MSB", "Electrical", ["Pr_60_70_22_19", "Cubicle switchboards"], ["board", "power"], ELECTRICAL, { match: /\bmsb\b|\bmdb\b|\blvsb\b|\blvp\b|main (lv )?switch ?board|main distribution board|main lv panel|\bemsb\b|essential (main )?switchboard|lv switchboard|\bswitch ?board\b|\bswb\b|switchgear/, categories: [...ELEC_EQ, "Generic Models", "Specialty Equipment"] }),
  k("bms-panel", "BMS controller", "BMS", "Low voltage", ["Pr_75_50_18_17", "Control panels"], ["signal", "power"], "", { match: /\bddc\b|\bbms\b|building management|\bbas\b|outstation|\bplc\b/, categories: [...ELEC_EQ, "Mechanical Control Devices", "Communication Devices", "Data Devices"] }),
  k("mcc", "Motor control centre", "MCC", "Electrical", ["Pr_75_50_18_53", "Motor starters control panels"], ["board", "power"], ELECTRICAL, { match: /\bmcc\b|motor control (centre|center|panel)|starter panel|control panel|fan panel|panel for (sef|ef|tef|kef|fan|ahu|pump)|(ahu|fan|pump) (control )?panel|\bvfd panel|\bvsd panel/, categories: ELEC_EQ }),
  k("vsd", "Variable speed drive", "VSD", "Electrical", ["Pr_75_51_52_94", "Variable speed drives"], ["power"], ELECTRICAL, { match: /\bvsd\b|\bvfd\b|variable (speed|frequency) drive|inverter drive/ }),
  k("distribution-board", "Distribution board", "DB", "Electrical", ["Pr_60_70_22_22", "Distribution boards"], ["board", "power"], ELECTRICAL, { match: /\bdb\b|\bldb\b|\bpdb\b|\bedb\b|\bemdb\b|\bfdb\b|\bdb[-_ ]|distribution ?boards?|panel ?boards?|lighting panel|power panel|consumer unit|\bpanel\b|\bboard\b/, categories: ELEC_EQ }),
  k("manhole", "Manhole / pit", "MH", "Electrical", null, [], "", { match: /manhole|man hole|\bmh\b|draw ?pit|hand ?hole|road crossing|cable pit|\bpit\b/, categories: [...ELEC_EQ, "Plumbing Fixtures", "Generic Models", "Site", "Specialty Equipment"] }),
  k("busbar", "Busbar trunking", "BB", "Electrical", ["Pr_60_70_48_66", "Power busbar trunking"], ["board", "power"], ELECTRICAL, { match: /bus ?bar|bus ?duct|busway|tap[- ]off/ }),
  k("capacitor-bank", "Power factor correction", "PFC", "Electrical", null, ["power"], ELECTRICAL, { match: /capacitor bank|power factor|\bpfc\b|harmonic filter/ }),
  k("ev-charger", "EV charger", "EVCP", "Electrical", ["Pr_65_72_97_29", "Electric vehicle charging points"], ["power"], ELECTRICAL, { match: /\bev\b.*charg|electric vehicle|charging (point|station)|wallbox/ }),
  k("pv", "Solar PV / inverter", "PV", "Electrical", ["Pr_60_70_65_63", "Photovoltaic modules"], ["source", "power"], ELECTRICAL, { match: /photovoltaic|\bpv\b|solar (panel|module|inverter)/ }),
  k("meter-electric", "Electricity meter", "EM", "Electrical", ["Pr_80_51_51_28", "Energy meters"], ["power"], "", { match: /(kwh|energy|electric(ity)?|power|smart) meter|\bmeter\b/, categories: ELEC_EQ }),

  // Lighting
  k("exit-sign", "Exit sign", "EX", "Electrical", ["Pr_40_10_57_45", "Internally illuminated emergency exit signs"], ["lighting", "emergency", "power"], EMERGENCY, { match: /exit sign|\bexit\b|running man|escape sign|crossign|emergency sign|evacuation sign/, categories: ["Lighting Fixtures", "Lighting Devices", "Electrical Fixtures", "Generic Models", "Specialty Equipment"] }),
  k("emergency-light", "Emergency light", "EL", "Electrical", ["Pr_70_70_48_25", "Emergency luminaires"], ["lighting", "emergency", "power"], EMERGENCY, { match: /emergency|\bem\b|\bem[-_ ]|\bemerg|escape (route )?light|self[- ]test|slave luminaire|maintained|non-maintained|\bnm\b/, categories: ["Lighting Fixtures"] }),
  k("lighting-control", "Lighting control", "LC", "Electrical", ["Pr_70_70_47_45", "Lighting control modules"], ["power"], "", { match: /lighting control|\bdali\b|\bknx\b|occupancy|presence|\bpir\b|daylight|photocell|light sensor|scene (plate|panel)|dimmer|lighting controller/, categories: ["Lighting Devices", "Electrical Fixtures", "Electrical Equipment", "Communication Devices"] }),
  k("light-switch", "Light switch", "SW", "Electrical", ["Pr_65_72_97_46", "Light switches"], ["power"], "", { match: /switch/, categories: ["Lighting Devices"] }),
  k("light-fitting", "Light fitting", "LT", "Electrical", ["Pr_70_70_48", "Luminaires, lighting track and lighting accessories"], ["lighting", "power"], "", { categories: ["Lighting Fixtures"] }),

  // Small power and electrical fixtures
  k("electrical-fixture", "Electrical accessory", "EA", "Electrical", null, ["power"], "", { categories: ["Electrical Fixtures"] }),

  // Low voltage / ELV
  k("cctv", "CCTV camera", "CAM", "Low voltage", ["Pr_60_75_86", "Surveillance cameras, monitors and ancillaries"], ["signal", "power"], "", { match: /cctv|camera|\bptz\b|dome|bullet cam|\banpr\b/ }),
  k("card-reader", "Access control reader", "ACR", "Low voltage", ["Pr_75_30_30_67", "Proximity card readers"], ["signal"], "", { match: /card reader|access control|reader|proximity|biometric|keypad|fingerprint/ }),
  k("door-release", "Door release / lock", "DRL", "Low voltage", ["Pr_75_30_23", "Door and gate-operating hardware"], ["signal"], "", { match: /mag ?lock|magnetic lock|electric (lock|strike)|door (holder|release|controller|contact)|exit button|request to exit|\brex\b|break ?glass (unit|door)|emergency door release/ }),
  k("intercom", "Intercom", "INT", "Low voltage", ["Pr_75_30_30_42", "Intercom entrance panels"], ["signal"], "", { match: /intercom|door entry|video entry|help point|call station/ }),
  k("intruder", "Intruder detector", "IDS", "Low voltage", ["Pr_75_80_42_60", "Passive infrared detectors"], ["signal"], "", { match: /intruder|\bpir\b|motion|glass break|vibration|seismic detector|panic (button|alarm)|hold[- ]up/, categories: ["Security Devices"] }),
  k("security-device", "Security device", "SEC", "Low voltage", null, ["signal"], "", { categories: ["Security Devices"] }),
  k("wap", "Wireless access point", "WAP", "Low voltage", ["Pr_70_75_52", "Computer network products"], ["signal"], "", { match: /access point|\bwap\b|wi-?fi|wireless|\bwlan\b|\bdas\b|antenna/ }),
  k("network", "Network equipment", "NET", "Low voltage", ["Pr_70_75_52_56", "Network switches"], ["signal", "power"], "", { match: /network switch|\bswitch\b|router|server|\brack\b|cabinet|patch panel|\bcer\b|\bser\b|\bidf\b|\bmdf\b|comms (room|cabinet)/, categories: ["Data Devices", "Communication Devices", "Electrical Equipment", "Specialty Equipment"] }),
  k("data-outlet", "Data outlet", "DO", "Low voltage", ["Pr_70_75_04_06", "Balanced twisted pair cable outlet plates"], ["signal"], "", { match: /data|rj45|network outlet|telecom|\btel\b|tv outlet|outlet/, categories: ["Data Devices", "Telephone Devices", "Communication Devices"] }),
  k("loudspeaker", "Loudspeaker", "LS", "Low voltage", ["Pr_70_75_06_50", "Loudspeakers"], ["signal"], "", { match: /speaker|loudspeaker|\bpa\b|public address|amplifier|background music/ }),
  k("display", "Display / AV", "AV", "Low voltage", ["Pr_60_75_03_78", "Televisions"], ["signal", "power"], "", { match: /display|screen|\btv\b|television|monitor|projector|led wall|video wall|signage player/ }),
  k("nurse-call", "Nurse call", "NC", "Low voltage", ["Pr_75_75_04_57", "Nurse call units"], ["signal"], "", { categories: ["Nurse Call Devices"] }),
  k("clock", "Clock", "CLK", "Low voltage", ["Pr_40_50_13", "Clocks"], ["signal"], "", { match: /clock/ }),
  k("gas-detector", "Gas detector", "GD", "Low voltage", ["Pr_75_50_76_33", "Gas detectors"], ["signal"], GAS, { match: /gas detect|co detector|co2 sensor|carbon monoxide|refrigerant leak|leak detect/ }),
  k("bms", "BMS / control device", "CTL", "Low voltage", ["Pr_75_50_76", "Sensors and detectors"], ["signal"], "", { match: /sensor|thermostat|controller|\bbms\b|\bddc\b|outstation|transmitter|\bbacnet\b|actuator/, categories: ["Mechanical Control Devices", "Communication Devices", "Data Devices", "Electrical Fixtures", "Mechanical Equipment", "Duct Accessories", "Pipe Accessories"] }),
  k("communication-device", "Communication device", "COM", "Low voltage", null, ["signal"], "", { categories: ["Communication Devices", "Telephone Devices", "Data Devices", "Audio Visual Devices", "Mechanical Control Devices"] }),

  // HVAC
  k("chiller", "Chiller", "CH", "HVAC", ["Pr_60_60_13", "Chillers and cooling towers"], ["water", "refrigerant", "source", "power"], FGAS, { match: /chiller/ }),
  k("cooling-tower", "Cooling tower", "CT", "HVAC", ["Pr_60_60_13", "Chillers and cooling towers"], ["water", "power"], WATER, { match: /cooling tower|dry cooler|fluid cooler/ }),
  k("boiler", "Boiler", "BLR", "HVAC", ["Pr_60_60_08", "Boilers"], ["water", "source", "power"], PRESSURE, { match: /boiler|steam generator/ }),
  k("heat-pump", "Heat pump", "HP", "HVAC", ["Pr_70_60_37", "Heat pumps"], ["water", "refrigerant", "source", "power"], FGAS, { match: /heat pump|\bashp\b|\bgshp\b|\bwshp\b/ }),
  k("vrf-outdoor", "VRF / condensing unit", "CU", "HVAC", ["Pr_70_65_03_94", "Variable refrigerant flow units"], ["refrigerant", "source", "power"], FGAS, { match: /\bodu\b|outdoor unit|condensing unit|condenser unit|\bvrf\b.*(outdoor|condens)|\bvrv\b.*(outdoor|condens)|\bccu\b|\bacc?u\b/ }),
  k("vrf-indoor", "VRF / split indoor unit", "IDU", "HVAC", ["Pr_70_65_03_86", "Split coil room air conditioning units"], ["air", "refrigerant", "power"], FGAS, { match: /\bidu\b|indoor unit|cassette|\bvrf\b|\bvrv\b|split (unit|ac|system)|ducted split|wall[- ]mounted (split|ac)|high wall|\bdx\b|\bcrac\b|close control|precision (ac|air)/ }),
  k("ahu", "Air handling unit", "AHU", "HVAC", ["Pr_60_65_03", "Air-handling units"], ["air", "water", "power"], "", { match: /\bahu\b|\bfahu\b|\bpau\b|\bdoas\b|\bmau\b|air[- ]handl|primary air|fresh air (handling )?unit|make[- ]?up air|heat recovery (unit|ventilat)|\bhru\b|\berv\b|\bmvhr\b|\brtu\b|rooftop unit|\bcrah\b/ }),
  k("fcu", "Fan coil unit", "FCU", "HVAC", ["Pr_70_65_03_29", "Fan coil units"], ["air", "water", "power"], "", { match: /\bfcu\b|fan ?coil|blower coil|\bfcu[-_]/, categories: MECH }),
  k("vav", "VAV / CAV terminal", "VAV", "HVAC", ["Pr_70_65_04_94", "Variable air volume (VAV) terminal units"], ["air", "power"], "", { match: /\bvav\b|\bcav\b|variable air volume|constant air volume|terminal unit|\bfpb\b|fan powered box|chilled beam/ }),
  k("fan", "Fan", "FAN", "HVAC", ["Pr_65_67_29", "Fans"], ["air", "power"], "", { match: /\bfan\b|jet ?fan|\bkef\b|\btef\b|\bsef\b|\bsaf\b|\bref\b|\beaf\b|\bsf\b|\bef\b|ventilator|blower|smoke extract fan|pressuri[sz]ation fan|stair pressur/, categories: [...MECH, "Duct Accessories", "Air Terminals"] }),
  k("air-curtain", "Air curtain", "AC", "HVAC", ["Pr_70_60_36_02", "Air curtains"], ["air", "power"], "", { match: /air curtain|door curtain|door heater/, notCategories: ACCESSORIES }),
  k("heat-exchanger", "Heat exchanger", "HEX", "HVAC", ["Pr_60_60_38_62", "Plate heat exchangers"], ["water"], PRESSURE, { match: /heat exchanger|\bphe\b|\bhex\b|plate heat|heat interface unit|\bhiu\b|calorifier/ }),
  k("humidifier", "Humidifier", "HUM", "HVAC", ["Pr_65_67_39", "Humidifiers and dehumidifiers"], ["air", "water", "power"], WATER, { match: /humidifier|dehumidifier/ }),
  k("electric-heater", "Electric heater", "EH", "HVAC", ["Pr_70_60_36_93", "Unit heaters"], ["power"], "", { match: /(duct|electric|unit|panel|convector|fan) heater|heater battery|heating (element|coil)/ }),
  k("pressurisation-unit", "Pressurisation unit", "PU", "HVAC", ["Pr_65_53_86_68", "Pressurization units"], ["water", "power"], PRESSURE, { match: /pressuri[sz]ation (unit|set)|spill tank|make[- ]?up unit/ }),
  k("expansion-vessel", "Expansion vessel", "EXV", "HVAC", ["Pr_60_50_20_28", "Expansion vessels"], ["water", "tank"], PRESSURE, { match: /expan[st]ion (vessel|tank)|buffer vessel|air separator|dirt separator|deaerator|degasser/ }),
  k("fuel-tank", "Fuel tank", "FT", "Specialist", null, ["tank"], "", { match: /diesel tank|day tank|fuel (oil )?tank|oil tank|fuel storage/ }),
  k("gauge", "Gauge / test point", "GAU", "HVAC", null, ["water"], "", { match: /gauge|test point|binder point|pressure tapping|thermometer|orifice plate/, categories: ["Pipe Accessories", "Duct Accessories", "Mechanical Equipment"] }),
  k("water-treatment", "Water treatment", "WT", "HVAC", ["Pr_60_55_97", "Water treatment products"], ["water"], WATER, { match: /dosing|water treatment|chemical (pot|feeder)|side[- ]stream filter|\buv\b steril|softener|filtration (plant|unit)|ion exchange/ }),
  k("kitchen-extract", "Kitchen extract hood", "KH", "HVAC", ["Pr_60_65_94_46", "Kitchen extractor hoods"], ["air"], FIRE, { match: /kitchen (hood|canopy|extract)|extract canopy|cooker hood|\besp\b.*kitchen|ecology unit/ }),
  k("attenuator", "Sound attenuator", "ATT", "HVAC", ["Pr_65_67_78", "Sound attenuators"], ["air"], "", { match: /attenuator|silencer/, categories: ["Duct Accessories", "Mechanical Equipment"] }),
  k("damper", "Damper", "DMP", "HVAC", ["Pr_65_65_24", "Duct dampers"], ["damper", "air"], "", { match: /damper|\bvcd\b|\bmd\b|\bmvd\b|shutter/, categories: ["Duct Accessories", "Mechanical Equipment"] }),
  k("air-terminal", "Air terminal", "AT", "HVAC", ["Pr_70_65_04", "Air terminals and diffusers"], ["air"], "", { categories: ["Air Terminals"] }),
  k("duct-accessory", "Duct accessory", "DA", "HVAC", null, ["air"], "", { categories: ["Duct Accessories"] }),

  // Plumbing and public health
  k("water-heater", "Water heater", "WH", "Plumbing", ["Pr_60_60_96", "Water heaters"], ["water", "tank", "power"], WATER, { match: /water heater|\bewh\b|geyser|hot water (cylinder|heater|unit)|storage heater|instantaneous|\bpou\b/ }),
  k("booster-set", "Booster pump set", "BPS", "Plumbing", ["Pr_65_53_86_66", "Pressure booster pumps"], ["pump", "water", "power"], WATER, { match: /booster|pressure set|pump set|hydro[- ]?pneumatic/ }),
  k("sump-pump", "Sump / sewage pump", "SP", "Plumbing", ["Pr_65_53_24_86", "Submersible pumps"], ["pump", "water", "power"], "", { match: /sump|sewage pump|submersible|lifting station|ejector|drainage pump|grinder pump|macerator/ }),
  k("pump", "Pump", "PMP", "HVAC", ["Pr_65_53_86", "Supply and exhaust pumps"], ["pump", "water", "power"], "", { match: /pump|\bpmp\b|\bchwp\b|\bcwp\b|\bhwp\b|\bpchw\b|\bschw\b/ }),
  k("water-tank", "Water tank", "TNK", "Plumbing", ["Pr_60_50_96", "Water tanks and cisterns"], ["water", "tank"], WATER, { match: /tank|reservoir|break tank|storage vessel|thermal store/, categories: [...MECH, "Generic Models"] }),
  k("grease-trap", "Grease separator / interceptor", "GT", "Plumbing", ["Pr_65_52_25_32", "Free-standing grease separators and converters"], ["water"], "", { match: /grease (trap|separator|interceptor)|interceptor|oil separator|petrol separator|silt trap/ }),
  k("tmv", "Thermostatic mixing valve", "TMV", "Plumbing", ["Pr_65_54_95_88", "Thermostatic mixing valves"], ["water"], WATER, { match: /\btmv\b|thermostatic mixing|blending valve|mixing valve/ }),
  k("backflow", "Backflow preventer", "BFP", "Plumbing", ["Pr_65_54_95_94", "Verifiable backflow prevention devices"], ["water"], WATER, { match: /backflow|\brpz\b|double check valve|\bdcv\b|reduced pressure zone/ }),
  k("water-meter", "Water / heat meter", "WM", "Plumbing", ["Pr_80_51_51_97", "Water meters"], ["water"], "", { match: /water meter|heat meter|btu meter|energy meter|flow ?meter|\bmeter\b/, categories: ["Pipe Accessories", "Plumbing Equipment", "Mechanical Equipment", "Plumbing Fixtures"] }),
  k("valve", "Valve", "VLV", "Plumbing", null, ["water"], "", { match: /valve|\bpicv\b|\bdpcv\b|\bprv\b|\bcv\b|\biv\b|\bbv\b|\bnrv\b|\bdrv\b|\bcsv\b/, categories: ["Pipe Accessories", "Mechanical Equipment", "Plumbing Equipment"] }),
  k("strainer", "Strainer / filter", "STR", "Plumbing", null, ["water"], "", { match: /strainer|filter|y-type|pot filter/, categories: ["Pipe Accessories"] }),
  k("pipe-accessory", "Pipe accessory", "PA", "Plumbing", null, ["water"], "", { categories: ["Pipe Accessories"] }),
  k("drinking-fountain", "Drinking fountain / water cooler", "DF", "Plumbing", ["Pr_40_70_15_24", "Drinking fountains"], ["water", "power"], WATER, { match: /drinking|water cooler|bottle fill|water dispenser|fountain/ }),
  k("shower", "Shower", "SHW", "Plumbing", null, ["water"], WATER, { match: /shower|eye ?wash/, categories: ["Plumbing Fixtures", "Specialty Equipment"] }),
  k("tap", "Tap / mixer", "TAP", "Plumbing", null, ["water"], WATER, { match: /\btaps?\b|faucet|mixer|spout|sensor tap|\bbib\b/, categories: ["Plumbing Fixtures"] }),
  k("wc", "WC", "WC", "Plumbing", ["Pr_40_20_93_97", "WC suites"], ["water"], "", { match: /\bwc\b|water closet|toilet|\bpan\b|close coupled|squat|cistern|flush (pipe|valve|plate)|flushometer|conceala/, categories: ["Plumbing Fixtures"] }),
  k("urinal", "Urinal", "UR", "Plumbing", ["Pr_40_20_93", "Urinal and WC fittings"], ["water"], "", { match: /urinal/, categories: ["Plumbing Fixtures"] }),
  k("washbasin", "Wash basin", "WHB", "Plumbing", ["Pr_40_20_96", "Washbasins, sinks and troughs"], ["water"], "", { match: /basin|lavatory|\bwhb\b|vanity|hand ?wash|ablution/, categories: ["Plumbing Fixtures"] }),
  k("sink", "Sink", "SNK", "Plumbing", ["Pr_40_20_96", "Washbasins, sinks and troughs"], ["water"], "", { match: /sink|trough|slop|janitor|cleaner'?s/, categories: ["Plumbing Fixtures"] }),
  k("bath", "Bath", "BTH", "Plumbing", ["Pr_40_20_06_08", "Baths"], ["water"], WATER, { match: /\bbath\b|bathtub|jacuzzi|whirlpool/, categories: ["Plumbing Fixtures"] }),
  k("drain", "Floor drain / gully", "FDR-P", "Plumbing", null, ["water"], "", { match: /drain|gully|gulley|outlet|clean ?out|rodding/, categories: ["Plumbing Fixtures"] }),
  k("hand-dryer", "Hand dryer", "HDR", "Electrical", null, ["power"], "", { match: /hand ?dryer|dryer|blade dryer/, categories: ["Plumbing Fixtures", "Electrical Fixtures", "Specialty Equipment"] }),
  k("washroom-accessory", "Washroom accessory", "WA", "Architectural", null, [], "", { match: /hook|mirror|\bbin\b|dispenser|grab (bar|rail)|cubicle|towel|napkin|soap|toilet roll|tissue|shelf|baby chang|sanitary disposal/, categories: ["Plumbing Fixtures", "Specialty Equipment", "Generic Models", "Furniture"] }),
  k("sanitary-fitting", "Sanitary fitting", "SAN", "Plumbing", null, ["water"], "", { categories: ["Plumbing Fixtures"] }),
  k("medical-gas", "Medical gas equipment", "MG", "Specialist", null, [], PRESSURE, { match: /medical gas|\bmga\b|oxygen|vacuum plant|\bagss\b|manifold|gas outlet|nitrous/ }),
  k("compressor", "Air compressor", "AC-C", "HVAC", null, ["power"], PRESSURE, { match: /compressor|compressed air|air receiver/ }),

  // Doors and openings
  k("fire-door", "Fire door", "FDR", "Architectural", ["Pr_30_59_24_28", "Fire doorsets"], ["door"], FIRE, { match: /fire|\bfd ?\d{2,3}\b|\bfd\b|\bfr\b|fire[- ]rated|\b(30|60|90|120)\s*min/, categories: ["Doors"] }),
  k("automatic-door", "Automatic door", "ADR", "Architectural", ["Pr_30_59_24", "Doorsets"], ["door", "power"], "", { match: /automatic|auto(matic)? (sliding|swing)|sliding (automatic|auto)|revolving|operator|power[- ]?operated|motori[sz]ed/, categories: ["Doors"] }),
  k("roller-shutter", "Roller shutter", "RS", "Architectural", ["Pr_30_59_84_73", "Roller shutters"], ["door", "power"], "", { match: /roller|rolling|shutter|sectional|overhead door|up[- ]and[- ]over|grille door|security grille/ }),
  k("gate", "Gate / barrier / turnstile", "GTE", "Architectural", ["Pr_30_59_34", "Gates and turnstiles"], ["door"], "", { match: /\bgate\b|barrier|turnstile|speed ?gate|bollard|boom/, categories: ["Doors", "Specialty Equipment", "Site", "Generic Models", "Security Devices"] }),
  k("door", "Door", "DR", "Architectural", ["Pr_30_59_24", "Doorsets"], ["door"], "", { categories: ["Doors"] }),

  // Specialist
  k("cold-room", "Cold room", "CR", "Specialist", null, ["refrigerant", "power"], FGAS, { match: /cold room|freezer room|walk[- ]in|cold store|chiller room/ }),
  k("catering", "Catering equipment", "KIT", "Specialist", ["Pr_40_70_65", "Preparation catering equipment"], ["power"], GAS, { categories: ["Food Service Equipment"] }),
  k("medical-equipment", "Medical equipment", "MED", "Specialist", null, ["power"], "", { categories: ["Medical Equipment"] }),

  // By category, when nothing more specific matched
  k("mechanical-equipment", "Mechanical equipment", "ME", "HVAC", null, ["power"], "", { categories: ["Mechanical Equipment"] }),
  k("plumbing-equipment", "Plumbing equipment", "PE", "Plumbing", null, ["water"], "", { categories: ["Plumbing Equipment"] }),
  k("electrical-equipment", "Electrical equipment", "EE", "Electrical", null, ["power"], ELECTRICAL, { categories: ["Electrical Equipment"] }),
  k("lighting-device", "Lighting device", "LD", "Electrical", null, ["power"], "", { categories: ["Lighting Devices"] }),
  k("fire-protection", "Fire protection equipment", "FPE", "Fire & life safety", null, [], FIRE, { categories: ["Fire Protection"] }),
  k("specialty-equipment", "Specialty equipment", "SPE", "Specialist", null, [], "", { categories: ["Specialty Equipment"] }),
];

const FALLBACK: AssetKind = { id: "asset", label: "Asset", code: "AST", discipline: "Specialist", compliance: "", uniclass: null, traits: [] };

function find(category: string, text: string): Rule | null {
  for (const rule of RULES) {
    if (rule.categories && !rule.categories.includes(category)) continue;
    if (rule.notCategories?.includes(category)) continue;
    if (rule.match && !rule.match.test(text)) continue;
    if (!rule.match && !rule.categories) continue;
    return rule;
  }
  return null;
}

/**
 * The kind of an asset from its Revit category, family, type and name; tags
 * and board names (`extra`) decide only when those leave it open ("Plug Fan"
 * tagged AHU-02-SF is a fan, a generic box tagged AHU-01 an air handler).
 */
export function assetKind(category: string, family: string, type: string, name: string, extra = ""): AssetKind {
  const text = ` ${words(family)} ${words(type)} ${words(name)} `;
  const first = find(category, text);
  if (first?.match || !extra.trim()) return first ?? FALLBACK;
  const second = find(category, `${text} ${words(extra)} `);
  return (second?.match ? second : first) ?? FALLBACK;
}

/** "60_70_22_22_DistributionBoards_Generic" -> "60 70 22 22 distribution boards generic". */
function words(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .toLowerCase();
}

/** Uniclass product code a family name starts with (NBS object naming: "60_70_22_22_DistributionBoards…" -> Pr_60_70_22_22). */
export function familyUniclass(family: string): [string, string] | null {
  const m = /^(?:Pr_)?(\d{2})_(\d{2})_(\d{2})(?:_(\d{2}))?(?=[_\s-]|$)/i.exec(family.trim());
  if (!m) return null;
  const code = `Pr_${m[1]}_${m[2]}_${m[3]}${m[4] ? `_${m[4]}` : ""}`;
  return [code, KNOWN_PR.get(code) ?? ""];
}

export const ASSET_KINDS: AssetKind[] = [...RULES, FALLBACK];

const KNOWN_PR = new Map(RULES.filter((r) => r.uniclass).map((r) => r.uniclass!));

/** Suggested Uniclass 2015 Ss (systems) code for a distribution system, by its classification and name. */
export function systemUniclass(classification: string, name: string): [string, string] | null {
  const t = `${classification} ${name}`.toLowerCase();
  const rules: [RegExp, [string, string]][] = [
    [/fire alarm|detection/, ["Ss_75_50_28_29", "Fire detection and alarm systems"]],
    [/sprinkler|fire protection wet|fire protection dry|pre-?action|deluge/, ["Ss_55_30_98_85", "Sprinkler systems"]],
    [/wet riser/, ["Ss_55_30_96_97", "Wet riser systems"]],
    [/dry riser/, ["Ss_55_30_96_25", "Dry riser systems"]],
    [/hose reel/, ["Ss_55_30_96_29", "Fire hose reel systems"]],
    [/hydrant/, ["Ss_55_30_96_30", "Fire hydrant systems"]],
    [/smoke/, ["Ss_65_40_80_80", "Smoke and heat exhaust ventilation systems"]],
    [/kitchen extract/, ["Ss_65_40_33_45", "Kitchen extract ventilation systems"]],
    [/toilet extract/, ["Ss_65_40_33_90", "Toilet extract ventilation systems"]],
    [/exhaust|extract/, ["Ss_65_40_33_50", "Mechanical extract ventilation systems"]],
    [/supply air|fresh air|outside air|return air|ventilat/, ["Ss_65_40_33_51", "Mechanical supply ventilation systems"]],
    [/chilled|chw/, ["Ss_60_40_17_12", "Chilled water systems"]],
    [/condenser/, ["Ss_60_40_17_15", "Condenser water systems"]],
    [/refrigerant|vrf|vrv/, ["Ss_60_60_70_94", "Variable refrigerant flow systems"]],
    [/heating|lthw|hydronic/, ["Ss_60_40_37_48", "Low-temperature hot water heating systems"]],
    [/domestic hot|dhw|hot water/, ["Ss_55_70_38_42", "Indirect hot water storage supply systems"]],
    [/domestic cold|dcw|cold water|potable/, ["Ss_55_70_38_15", "Cold water supply systems"]],
    [/rain|storm/, ["Ss_50_30_02", "Rainwater drainage systems"]],
    [/sanitary|soil|waste|foul|drain/, ["Ss_50_30", "Above-ground drainage collection systems"]],
    [/medical gas/, ["Ss_55_20_51", "Medical gas and vacuum systems"]],
    [/emergency light/, ["Ss_70_80_33_12", "Central battery-supplied emergency lighting systems"]],
    [/lighting/, ["Ss_70_80_33", "General lighting systems"]],
    [/power|electrical|distribution|supply/, ["Ss_70_30_45_45", "Low-voltage distribution systems"]],
    [/data|network/, ["Ss_75_10_21_21", "Data distribution systems"]],
    [/cctv|surveillance/, ["Ss_75_40_53_86", "Surveillance CCTV systems"]],
    [/access control/, ["Ss_75_40_02", "Access control systems"]],
    [/public address/, ["Ss_75_10_68_68", "Public address systems"]],
    [/voice alarm/, ["Ss_75_50_28_95", "Voice alarm systems"]],
    [/nurse call/, ["Ss_75_50_11_57", "Nurse call systems"]],
  ];
  for (const [re, code] of rules) if (re.test(t)) return code;
  return null;
}
