// The asset information fields the register fills, and how they are found in
// a model's properties.
//
// Models name the same information differently: COBie parameters added with
// Autodesk's COBie extension ("COBie.Type.Manufacturer"), Revit's own
// ("Manufacturer", "Model", "Mark", "Type Mark", "Assembly Code"), project
// shared parameters ("Serial Number", "Installation Date", "Expected Life",
// "PPM Frequency"), in Navisworks tabs ("Element", "Revit Type") or Revit
// groups ("Identity Data", "Other"). Each field lists the property names it
// accepts, best first; names are compared without case, spaces or
// punctuation. Type fields prefer type tabs, component fields instance tabs.

import type { Discipline, Trait } from "./kinds";

export type FieldLevel = "type" | "component" | "space";
export type FieldKind = "text" | "date" | "year" | "duration" | "number" | "money" | "quantity";
export type FieldGroup = "identity" | "product" | "lifecycle" | "maintenance" | "location" | "electrical" | "technical" | "fire" | "cafm" | "room";

export interface FieldDef {
  id: string;
  label: string;
  level: FieldLevel;
  kind: FieldKind;
  /** Property names, best first. */
  names: string[];
  /** What the field is for, shown next to it on the Convert page. */
  hint?: string;
  /** Where the field is listed (set below for the older fields). */
  group?: FieldGroup;
  /** Quantity fields: the unit values are converted to ("L/s", "kW", "A"…; "" for plain numbers). */
  unit?: string;
  /** Only read for assets of these traits, disciplines or categories (and none of `not`). */
  applies?: { traits?: Trait[]; disciplines?: Discipline[]; categories?: string[]; not?: Trait[] };
  /** Fields sharing this tag never read the same property of one asset ("Flow" is airflow or water flow, not both). */
  exclusive?: string;
}

export const FIELDS: FieldDef[] = [
  // Type (one value per family type)
  { id: "manufacturer", label: "Manufacturer", level: "type", kind: "text", names: ["COBie.Type.Manufacturer", "Manufacturer", "Manufacturer Name", "Make", "Brand", "Mfr"] },
  { id: "model", label: "Model", level: "type", kind: "text", names: ["COBie.Type.ModelNumber", "Model Number", "Model", "Model No", "ModelNumber", "Model Name", "Model Label"] },
  { id: "modelReference", label: "Model reference", level: "type", kind: "text", names: ["COBie.Type.ModelReference", "Model Reference", "Product Code", "Article Number", "Catalogue Number", "Catalog Number", "Part Number", "Product Number"] },
  { id: "typeMark", label: "Type mark", level: "type", kind: "text", names: ["Type Mark", "COBie.Type.Name"] },
  { id: "typeDescription", label: "Type description", level: "type", kind: "text", names: ["COBie.Type.Description", "Description", "Type Comments", "Type Description"] },
  { id: "classification", label: "Classification", level: "type", kind: "text", names: ["COBie.Type.Category", "Classification.Uniclass.Pr.Number", "Classification.Uniclass.Ss.Number", "Uniclass", "Uniclass Code", "OmniClass Number", "Assembly Code", "NRM", "Classification"] },
  { id: "classificationTitle", label: "Classification title", level: "type", kind: "text", names: ["Classification.Uniclass.Pr.Description", "Classification.Uniclass.Ss.Description", "Uniclass Title", "OmniClass Title", "Assembly Description", "Classification Title"] },
  { id: "assetType", label: "Asset type (fixed / moveable)", level: "type", kind: "text", names: ["COBie.Type.AssetType", "Asset Type"] },
  { id: "supplier", label: "Supplier", level: "type", kind: "text", names: ["Supplier", "Supplied By", "Vendor", "Distributor", "Local Supplier", "Local Agent"] },
  { id: "warrantyGuarantorParts", label: "Warranty guarantor (parts)", level: "type", kind: "text", names: ["COBie.Type.WarrantyGuarantorParts", "Warranty Guarantor Parts", "Warranty Guarantor", "Warranty Provider", "Guarantor", "Point Of Contact"] },
  { id: "warrantyDurationParts", label: "Warranty duration (parts)", level: "type", kind: "duration", names: ["COBie.Type.WarrantyDurationParts", "Warranty Duration Parts", "Warranty Duration", "Warranty Period", "Warranty Years", "Warranty"] },
  { id: "warrantyGuarantorLabor", label: "Warranty guarantor (labour)", level: "type", kind: "text", names: ["COBie.Type.WarrantyGuarantorLabor", "Warranty Guarantor Labor", "Warranty Guarantor Labour"] },
  { id: "warrantyDurationLabor", label: "Warranty duration (labour)", level: "type", kind: "duration", names: ["COBie.Type.WarrantyDurationLabor", "Warranty Duration Labor", "Warranty Duration Labour"] },
  { id: "warrantyDurationUnit", label: "Warranty duration unit", level: "type", kind: "text", names: ["COBie.Type.WarrantyDurationUnit", "Warranty Duration Unit", "Warranty Unit"] },
  { id: "warrantyDescription", label: "Warranty description", level: "type", kind: "text", names: ["COBie.Type.WarrantyDescription", "Warranty Description", "Warranty Terms", "Warranty Content"] },
  { id: "replacementCost", label: "Replacement cost", level: "type", kind: "money", names: ["COBie.Type.ReplacementCost", "Replacement Cost", "Cost", "Unit Cost", "Unit Price"] },
  { id: "expectedLife", label: "Expected life", level: "type", kind: "duration", names: ["COBie.Type.ExpectedLife", "Expected Life", "Service Life", "Design Life", "Life Expectancy", "Lifespan", "Life Span", "Useful Life", "Economic Life", "Expected Lifetime", "Expected Service Life", "Service Lifetime", "Design Lifetime", "Lifetime", "Service Life Duration"] },
  { id: "durationUnit", label: "Life duration unit", level: "type", kind: "text", names: ["COBie.Type.DurationUnit", "Duration Unit", "Life Unit"] },
  { id: "nominalLength", label: "Nominal length", level: "type", kind: "number", names: ["COBie.Type.NominalLength", "Nominal Length", "Length", "Depth"] },
  { id: "nominalWidth", label: "Nominal width", level: "type", kind: "number", names: ["COBie.Type.NominalWidth", "Nominal Width", "Width"] },
  { id: "nominalHeight", label: "Nominal height", level: "type", kind: "number", names: ["COBie.Type.NominalHeight", "Nominal Height", "Height"] },
  { id: "shape", label: "Shape", level: "type", kind: "text", names: ["COBie.Type.Shape", "Shape"] },
  { id: "size", label: "Size", level: "type", kind: "text", names: ["COBie.Type.Size", "Size", "Overall Size", "Nominal Size"] },
  { id: "color", label: "Colour", level: "type", kind: "text", names: ["COBie.Type.Color", "Color", "Colour"] },
  { id: "finish", label: "Finish", level: "type", kind: "text", names: ["COBie.Type.Finish", "Finish"] },
  { id: "grade", label: "Grade", level: "type", kind: "text", names: ["COBie.Type.Grade", "Grade"] },
  { id: "material", label: "Material", level: "type", kind: "text", names: ["COBie.Type.Material", "Material", "Body Material", "Structural Material"] },
  { id: "constituents", label: "Constituents", level: "type", kind: "text", names: ["COBie.Type.Constituents", "Constituents"] },
  { id: "features", label: "Features", level: "type", kind: "text", names: ["COBie.Type.Features", "Features"] },
  { id: "accessibilityPerformance", label: "Accessibility performance", level: "type", kind: "text", names: ["COBie.Type.AccessibilityPerformance", "Accessibility Performance"] },
  { id: "codePerformance", label: "Code performance", level: "type", kind: "text", names: ["COBie.Type.CodePerformance", "Code Performance"] },
  { id: "sustainabilityPerformance", label: "Sustainability performance", level: "type", kind: "text", names: ["COBie.Type.SustainabilityPerformance", "Sustainability Performance"] },
  { id: "url", label: "Product URL", level: "type", kind: "text", names: ["URL", "Manufacturer URL", "Product URL", "Website", "Datasheet", "Data Sheet"] },
  { id: "ppmTask", label: "PPM task", level: "type", kind: "text", names: ["COBie.Job.Name", "PPM Task", "Maintenance Task", "PPM", "PPM Schedule", "Maintenance Schedule", "SFG20 Code", "SFG20", "Maintenance Activity"], hint: "Planned preventive maintenance, when the model carries it" },
  { id: "ppmFrequency", label: "PPM frequency", level: "type", kind: "duration", names: ["COBie.Job.Frequency", "PPM Frequency", "Maintenance Frequency", "Service Frequency", "Maintenance Interval", "Service Interval", "Inspection Frequency", "Frequency of Maintenance", "Frequency of Service", "Frequency"] },
  { id: "ppmFrequencyUnit", label: "PPM frequency unit", level: "type", kind: "text", names: ["COBie.Job.FrequencyUnit", "PPM Frequency Unit", "Frequency Unit"] },
  { id: "ppmDuration", label: "PPM duration", level: "type", kind: "duration", names: ["COBie.Job.Duration", "PPM Duration", "Maintenance Duration", "Task Duration"] },

  // Component (one value per asset)
  { id: "tag", label: "Tag / mark", level: "component", kind: "text", names: ["COBie.Component.TagNumber", "Tag Number", "Asset Tag", "Equipment Tag", "Equipment Number", "Equipment No", "Mark", "Tag"] },
  { id: "serialNumber", label: "Serial number", level: "component", kind: "text", names: ["COBie.Component.SerialNumber", "Serial Number", "SerialNumber", "Serial No", "S/N"] },
  { id: "barCode", label: "Bar code", level: "component", kind: "text", names: ["COBie.Component.BarCode", "Bar Code", "Barcode", "QR Code", "RFID"] },
  { id: "assetIdentifier", label: "Asset identifier", level: "component", kind: "text", names: ["COBie.Component.AssetIdentifier", "Asset Identifier", "Asset ID", "Asset Number", "Asset No", "Asset Code", "Asset Reference", "Asset Ref", "Asset"] },
  { id: "installationDate", label: "Installation date", level: "component", kind: "date", names: ["COBie.Component.InstallationDate", "Installation Date", "Install Date", "Date Installed", "Installed Date", "Commissioning Date", "Commissioned Date", "Date of Installation"] },
  { id: "warrantyStartDate", label: "Warranty start", level: "component", kind: "date", names: ["COBie.Component.WarrantyStartDate", "Warranty Start Date", "Warranty Start", "Warranty Commencement"] },
  { id: "warrantyEndDate", label: "Warranty end", level: "component", kind: "date", names: ["Warranty End Date", "Warranty Expiry Date", "Warranty Expiry", "Warranty End"] },
  { id: "manufactureYear", label: "Manufacturing year", level: "component", kind: "year", names: ["Year of Manufacture", "Manufacturing Year", "Manufacture Year", "Year Manufactured", "Production Year", "ProductionYear", "Manufacturing Date", "Date of Manufacture", "Manufacture Date"] },
  { id: "endOfLife", label: "End of life", level: "component", kind: "date", names: ["End of Life", "End of Life Date", "EOL", "EOL Date", "Replacement Date", "Replacement Year", "Decommission Date", "Decommissioning Date"] },
  { id: "condition", label: "Condition", level: "component", kind: "text", names: ["Condition", "Asset Condition", "Condition Rating", "Condition Grade", "Assessment Condition"] },
  { id: "status", label: "Status", level: "component", kind: "text", names: ["Asset Status", "Operational Status", "Status"] },
  { id: "comments", label: "Comments", level: "component", kind: "text", names: ["COBie.Component.Description", "Comments", "Remarks", "Notes"] },
  { id: "space", label: "Space (room)", level: "component", kind: "text", names: ["COBie.Component.Space", "Space", "Room", "Space Number", "Room Number", "Room: Number", "Space: Number", "Space Name", "Room Name", "Room: Name", "Space: Name"], hint: "Where the asset is; the room it is in otherwise comes from room geometry" },
  { id: "systemName", label: "System name", level: "component", kind: "text", names: ["COBie.System.Name", "System Name", "System"] },
  { id: "systemClassification", label: "System classification", level: "component", kind: "text", names: ["System Classification", "COBie.System.Category"] },
  { id: "systemType", label: "System type", level: "component", kind: "text", names: ["System Type"] },
  { id: "panel", label: "Fed from (board)", level: "component", kind: "text", names: ["Panel", "Supply From", "Fed From", "Fed By", "Source Panel", "Feeder Ref", "Feeder Reference", "Feeder From", "Incoming Feeder", "Supplied From", "Distribution Board", "DB"], hint: "Electrical supply: the board an item is fed from" },
  { id: "panelName", label: "Board name", level: "component", kind: "text", names: ["Panel Name", "Board Name", "DB Name", "Distribution Board Name", "Switchboard Name"], hint: "A distribution board's own name, which fed items refer to" },
  { id: "circuit", label: "Circuit", level: "component", kind: "text", names: ["Circuit Number", "Circuit", "Circuit No", "Circuit Reference"] },
  { id: "servedBy", label: "Served by (stated)", level: "component", kind: "text", names: ["Served By", "Serviced By", "Source Equipment", "Upstream Equipment", "Fed By Equipment"] },
  { id: "serves", label: "Serves (stated)", level: "component", kind: "text", names: ["Serves", "Serving", "Feeds", "Downstream Equipment", "Served Area", "Served Spaces", "Area Served"] },

  // Electrical: boards and the circuits that feed items (single-line diagram data)
  { id: "voltage", label: "Voltage", level: "component", kind: "quantity", unit: "V", group: "electrical", names: ["Voltage", "Rated Voltage", "Nominal Voltage", "Supply Voltage", "Secondary Voltage", "Operating Voltage", "Input Voltage", "Volts"], applies: { traits: ["power", "board", "lighting", "lift", "pump"] } },
  { id: "phases", label: "Phases", level: "component", kind: "quantity", unit: "", group: "electrical", names: ["Number of Phases", "Phases", "No of Phases", "Phase"], applies: { traits: ["power", "board", "lighting"] } },
  { id: "distributionSystem", label: "Distribution system", level: "component", kind: "text", group: "electrical", names: ["Distribution System", "Supply System", "Supply Type", "Power Supply"], applies: { traits: ["board", "power"] }, hint: "Such as 400/230V 3P4W; voltage and phases are read from it" },
  { id: "electricalData", label: "Electrical data", level: "component", kind: "text", group: "electrical", names: ["Electrical Data", "Electrical Rating", "Power Supply Data"], applies: { traits: ["power", "lighting"] }, hint: "Revit's summary such as 230 V/1-120 VA; voltage, phases and load are read from it" },
  { id: "mainsRating", label: "Main rating", level: "component", kind: "quantity", unit: "A", group: "electrical", exclusive: "current", names: ["Mains", "Main Breaker Rating", "Main Rating", "Incomer Rating", "Incoming Rating", "Main Switch Rating", "Main Breaker", "MCCB Rating", "ACB Rating", "MCB Rating", "Busbar Rating", "Bus Rating", "Rated Current", "Current Rating", "Frame Size", "Rating"], applies: { traits: ["board"] }, hint: "A board's incoming rating, amperes" },
  { id: "ways", label: "Ways", level: "component", kind: "quantity", unit: "", group: "electrical", names: ["Number of Ways", "Ways", "No of Ways", "Outgoing Ways", "Number of Outgoing Ways", "Max #1 Pole Breakers", "Max Number of Circuit Breakers", "Max Number of Single Pole Breakers", "Number of Circuits"], applies: { traits: ["board"] } },
  { id: "connectedLoad", label: "Connected load", level: "component", kind: "quantity", unit: "kVA", group: "electrical", names: ["Total Connected Load", "Total Connected", "Connected Load", "Apparent Load", "Total Apparent Load", "Total Load", "Electrical Load", "Load"], applies: { traits: ["power", "board", "lighting"] } },
  { id: "demandLoad", label: "Demand load", level: "component", kind: "quantity", unit: "kVA", group: "electrical", names: ["Total Demand Load", "Total Estimated Demand", "Demand Load", "Maximum Demand", "Estimated Demand", "Total Demand"], applies: { traits: ["board"] } },
  { id: "faultLevel", label: "Fault level", level: "component", kind: "quantity", unit: "kA", group: "electrical", names: ["Short Circuit Rating", "Fault Level", "Prospective Fault Current", "Short Circuit Current", "Breaking Capacity", "Fault Rating", "kA Rating", "Icu", "Ics", "Icw", "Short Time Withstand"], applies: { traits: ["board"] } },
  { id: "poles", label: "Poles", level: "component", kind: "quantity", unit: "", group: "electrical", names: ["Number of Poles", "Poles", "No of Poles", "Pole"], applies: { traits: ["power", "lighting"] } },
  { id: "breakerRating", label: "Breaker rating", level: "component", kind: "quantity", unit: "A", group: "electrical", exclusive: "current", names: ["Breaker Rating", "Protective Device Rating", "Circuit Breaker Rating", "MCB Rating", "Trip Rating", "Fuse Rating", "Breaker Size", "Rating", "Trip"], applies: { traits: ["power", "lighting"], not: ["board"] }, hint: "The protective device of the circuit feeding the item, amperes" },
  { id: "cableSize", label: "Cable", level: "component", kind: "text", group: "electrical", names: ["Wire Size", "Cable Size", "Conductor Size", "Cable Reference", "Cable Type", "Cable", "Wire Type", "Cable Description"], applies: { traits: ["power", "board", "lighting"] } },
  { id: "loadName", label: "Load name", level: "component", kind: "text", group: "electrical", names: ["Load Name", "Circuit Description", "Circuit Name", "Load Description", "Circuit Load Name"], applies: { traits: ["power", "lighting"] } },
  { id: "loadClassification", label: "Load classification", level: "component", kind: "text", group: "electrical", names: ["Load Classification", "Load Classification Abbreviation", "Load Type", "Load Category", "Electrical Load Classification", "MagiCAD Electrical Load Classification", "Eload Classification"], applies: { traits: ["power", "lighting", "board"] } },
  { id: "ipRating", label: "IP rating", level: "component", kind: "text", group: "electrical", names: ["IP Rating", "Ingress Protection", "IP Code", "IP Class", "IP", "Degree of Protection", "Enclosure Rating", "Protection Rating", "Enclosure Protection"] },

  // MEP technical data
  { id: "airflow", label: "Airflow", level: "component", kind: "quantity", unit: "L/s", group: "technical", exclusive: "flow", names: ["Air Flow", "Airflow", "Air Flow Rate", "Airflow Rate", "Supply Air Flow", "Supply Airflow", "Design Airflow", "Design Air Flow", "Max Flow", "Actual Flow", "Flow", "Air Volume", "Supply Air Volume", "Volume Flow", "Fan Flow", "Exhaust Air Flow", "Extract Airflow", "Return Air Flow", "Outside Air Flow", "Fresh Air Flow"], applies: { traits: ["air"] } },
  { id: "waterFlow", label: "Water flow", level: "component", kind: "quantity", unit: "L/s", group: "technical", exclusive: "flow", names: ["Water Flow", "Water Flow Rate", "Design Water Flow", "Chilled Water Flow", "Hot Water Flow", "Condenser Water Flow", "CHW Flow", "Pump Flow", "Duty Flow", "Design Flow", "Flow Rate", "Flow"], applies: { traits: ["water", "pump", "sprinkler"] } },
  { id: "coolingCapacity", label: "Cooling capacity", level: "component", kind: "quantity", unit: "kW", group: "technical", exclusive: "capacity", names: ["Total Cooling Capacity", "Cooling Capacity", "Nominal Cooling Capacity", "Cooling Load", "Total Cooling Load", "Refrigeration Capacity", "Cooling Duty", "Cooling Output", "Total Capacity", "Cooling", "Capacity"], applies: { disciplines: ["HVAC"] } },
  { id: "sensibleCapacity", label: "Sensible cooling capacity", level: "component", kind: "quantity", unit: "kW", group: "technical", names: ["Sensible Cooling Capacity", "Sensible Capacity", "Sensible Cooling Load", "Sensible Cooling"], applies: { disciplines: ["HVAC"] } },
  { id: "heatingCapacity", label: "Heating capacity", level: "component", kind: "quantity", unit: "kW", group: "technical", exclusive: "capacity", names: ["Heating Capacity", "Nominal Heating Capacity", "Total Heating Capacity", "Heating Load", "Heat Output", "Heating Duty", "Heating Output", "Thermal Output", "Heating"], applies: { disciplines: ["HVAC", "Plumbing"] } },
  { id: "motorPower", label: "Motor power", level: "component", kind: "quantity", unit: "kW", group: "technical", names: ["Motor Power", "Motor Rating", "Motor kW", "Motor Size", "Motor Output", "Fan Motor Power", "Fan Power", "Pump Power", "Pump Motor Power", "Shaft Power", "Absorbed Power", "Rated Power", "Input Power", "Power Input", "Power", "Electrical Power", "Power Consumption"], applies: { traits: ["pump", "air", "lift", "refrigerant"], not: ["lighting", "damper"] } },
  { id: "esp", label: "External static pressure", level: "component", kind: "quantity", unit: "Pa", group: "technical", exclusive: "pressure", names: ["External Static Pressure", "ESP", "Ext Static Pressure", "External Pressure", "Available Static Pressure", "Fan Static Pressure", "Static Pressure", "Total Pressure", "Fan Pressure", "Pressure"], applies: { traits: ["air"], not: ["damper"] } },
  { id: "pumpHead", label: "Pump head", level: "component", kind: "quantity", unit: "kPa", group: "technical", exclusive: "pressure", names: ["Pump Head", "Total Head", "Head", "Pressure Head", "Total Dynamic Head", "Pump Pressure", "Differential Pressure", "Pressure"], applies: { traits: ["pump"] } },
  { id: "refrigerant", label: "Refrigerant", level: "component", kind: "text", group: "technical", names: ["Refrigerant", "Refrigerant Type", "Refrigerant Gas", "Refrigerant Name"], applies: { traits: ["refrigerant"] } },
  { id: "refrigerantCharge", label: "Refrigerant charge", level: "component", kind: "quantity", unit: "kg", group: "technical", names: ["Refrigerant Charge", "Refrigerant Quantity", "Refrigerant Weight", "Refrigerant Mass", "Factory Charge", "Charge"], applies: { traits: ["refrigerant"] } },
  { id: "efficiency", label: "Efficiency (EER / COP)", level: "component", kind: "text", group: "technical", names: ["EER", "SEER", "COP", "SCOP", "IPLV", "NPLV", "Energy Efficiency Ratio", "Coefficient of Performance", "Efficiency", "kW/TR"], applies: { disciplines: ["HVAC"] } },
  { id: "ratedCurrent", label: "Rated current", level: "component", kind: "quantity", unit: "A", group: "technical", exclusive: "current", names: ["Full Load Current", "Full Load Amps", "FLC", "FLA", "Rated Current", "Running Current", "Current", "Apparent Current", "MCA", "Max Current"], applies: { traits: ["power", "pump", "air", "refrigerant", "lift"], not: ["board"] } },
  { id: "weight", label: "Operating weight", level: "component", kind: "quantity", unit: "kg", group: "technical", names: ["Operating Weight", "Weight", "Dry Weight", "Unit Weight", "Shipping Weight", "Total Weight", "Mass"] },
  { id: "tankVolume", label: "Capacity / volume", level: "component", kind: "quantity", unit: "L", group: "technical", exclusive: "capacity", names: ["Storage Capacity", "Tank Capacity", "Storage Volume", "Nominal Volume", "Tank Volume", "Effective Volume", "Capacity"], applies: { traits: ["tank"] } },
  { id: "lampPower", label: "Luminaire power", level: "component", kind: "quantity", unit: "W", group: "technical", names: ["Wattage", "Luminaire Wattage", "Lamp Wattage", "Total Wattage", "Luminaire Power", "System Power", "Lamp Power", "Input Power", "Rated Power", "Power", "Connected Load", "Apparent Load"], applies: { traits: ["lighting"] } },
  { id: "luminousFlux", label: "Luminous flux", level: "component", kind: "quantity", unit: "lm", group: "technical", names: ["Luminous Flux", "Initial Luminous Flux", "Luminaire Luminous Flux", "Lumens", "Light Output", "Lumen Output", "Luminaire Lumens", "Lamp Lumens"], applies: { traits: ["lighting"] } },
  { id: "colourTemperature", label: "Colour temperature", level: "component", kind: "quantity", unit: "K", group: "technical", names: ["Colour Temperature", "Color Temperature", "CCT", "Initial Color Temperature", "Correlated Colour Temperature", "Colour Temp", "Color Temp"], applies: { traits: ["lighting"] } },
  { id: "emergencyType", label: "Emergency type", level: "component", kind: "text", group: "technical", names: ["Emergency Type", "Emergency", "Emergency Lighting", "Emergency Mode", "Emergency Function", "Emergency Operation", "Maintained"], applies: { traits: ["lighting", "emergency"] } },
  { id: "emergencyDuration", label: "Emergency duration", level: "component", kind: "quantity", unit: "h", group: "technical", names: ["Emergency Duration", "Battery Duration", "Emergency Autonomy", "Autonomy", "Rated Duration", "Duration"], applies: { traits: ["emergency", "lighting"] } },
  { id: "liftCapacity", label: "Rated load", level: "component", kind: "quantity", unit: "kg", group: "technical", exclusive: "capacity", names: ["Rated Load", "Load Capacity", "Rated Capacity", "Lift Capacity", "Car Capacity", "Duty Load", "Capacity"], applies: { traits: ["lift"] } },
  { id: "liftSpeed", label: "Rated speed", level: "component", kind: "quantity", unit: "m/s", group: "technical", names: ["Rated Speed", "Contract Speed", "Lift Speed", "Car Speed", "Nominal Speed", "Speed"], applies: { traits: ["lift"] } },
  { id: "liftPersons", label: "Persons", level: "component", kind: "quantity", unit: "", group: "technical", names: ["Number of Persons", "Persons", "Passengers", "Passenger Capacity", "Max Persons"], applies: { traits: ["lift"] } },
  { id: "floorsServed", label: "Floors served", level: "component", kind: "text", group: "technical", names: ["Floors Served", "Levels Served", "Served Floors", "Number of Stops", "Stops", "Landings", "Number of Landings"], applies: { traits: ["lift"] } },

  // Fire and life safety
  { id: "fireRating", label: "Fire rating", level: "component", kind: "text", group: "fire", names: ["Fire Rating", "Fire Resistance Rating", "Fire Resistance", "FRR", "Fire Rating (Minutes)", "Fire Resistance Period", "Fire Integrity", "Fire Performance", "Fire Rated", "FireRating"] },
  { id: "firePanel", label: "Fire alarm panel", level: "component", kind: "text", group: "fire", names: ["Fire Alarm Panel", "Fire Panel", "FACP", "Fire Alarm Control Panel", "Control Panel"], applies: { traits: ["fireAlarm"] }, hint: "Fire alarm devices also name their panel in Revit's Panel parameter" },
  { id: "loop", label: "Loop", level: "component", kind: "text", group: "fire", names: ["Loop", "Loop Number", "Loop No", "Fire Alarm Loop", "Detection Loop", "Loop ID", "Loop Name"], applies: { traits: ["fireAlarm"] }, hint: "Otherwise a fire alarm device's circuit number" },
  { id: "address", label: "Address", level: "component", kind: "text", group: "fire", names: ["Address", "Device Address", "Loop Address", "Fire Alarm Address", "Detector Address", "Point Number", "Point Address", "Device Number"], applies: { traits: ["fireAlarm"] } },
  { id: "fireZone", label: "Fire zone", level: "component", kind: "text", group: "fire", names: ["Fire Zone", "Fire Alarm Zone", "Detection Zone", "Alarm Zone", "Fire Detection Zone", "Evacuation Zone", "Sprinkler Zone", "Zone Number", "Zone", "Fire Compartment", "Compartment", "Smoke Zone", "Smoke Compartment"], applies: { disciplines: ["Fire & life safety"], traits: ["emergency"] } },
  { id: "activationTemperature", label: "Activation temperature", level: "component", kind: "quantity", unit: "°C", group: "fire", names: ["Temperature Rating", "Activation Temperature", "Operating Temperature", "Bulb Temperature", "Rated Temperature", "Release Temperature", "Fusible Link Temperature", "Trigger Temperature", "Nominal Operating Temperature"], applies: { traits: ["sprinkler", "damper", "fireAlarm"] } },
  { id: "kFactor", label: "K-factor", level: "component", kind: "quantity", unit: "", group: "fire", names: ["K-Factor", "K Factor", "KFactor", "K-factor (Metric)", "K Factor (Metric)", "Discharge Coefficient", "K"], applies: { traits: ["sprinkler"] } },
  { id: "sprinklerResponse", label: "Response", level: "component", kind: "text", group: "fire", names: ["Response Type", "Response", "RTI", "Response Time Index", "Bulb Type", "Sprinkler Response", "Bulb Size"], applies: { traits: ["sprinkler"] } },
  { id: "coverageArea", label: "Coverage area", level: "component", kind: "quantity", unit: "m²", group: "fire", names: ["Coverage Area", "Coverage", "Max Coverage", "Maximum Coverage Area", "Max Coverage Area", "Area of Coverage", "Spacing Area"], applies: { traits: ["sprinkler", "fireAlarm"] } },
  { id: "damperActuation", label: "Actuation", level: "component", kind: "text", group: "fire", names: ["Actuator", "Actuator Type", "Actuation", "Release Mechanism", "Fusible Link", "Operating Mechanism", "Operation"], applies: { traits: ["damper"] } },
  { id: "extinguisherType", label: "Extinguisher type", level: "component", kind: "text", group: "fire", names: ["Extinguisher Type", "Extinguishing Agent", "Agent", "Agent Type", "Extinguishing Media", "Media", "Fire Class"], applies: { traits: ["extinguisher"] } },

  // Asset management (CAFM): read when the model has them, otherwise left for the FM team
  { id: "parentAsset", label: "Parent asset", level: "component", kind: "text", group: "cafm", names: ["Parent Asset", "Parent Equipment", "Parent Asset Tag", "Parent Tag", "Parent", "Part Of", "Host Equipment", "COBie.Assembly.ParentName", "Assembly Name"], hint: "The asset this one is part of" },
  { id: "criticality", label: "Criticality", level: "component", kind: "text", group: "cafm", names: ["Criticality", "Asset Criticality", "Criticality Rating", "Business Criticality", "Critical", "Priority", "Risk Rating"] },
  { id: "maintainer", label: "Maintainer", level: "component", kind: "text", group: "cafm", names: ["Maintainer", "Maintenance Contractor", "Maintained By", "Service Provider", "FM Contractor", "Maintenance Responsibility", "Responsible Party", "Responsibility"] },
  { id: "installer", label: "Installed by", level: "component", kind: "text", group: "cafm", names: ["Installed By", "Installer", "Installation Contractor", "Installing Contractor", "Subcontractor", "Sub Contractor", "MEP Contractor"], hint: "The contractor that installed the asset (for warranty claims)" },
  { id: "statutory", label: "Statutory", level: "component", kind: "text", group: "cafm", names: ["Statutory", "Statutory Requirement", "Statutory Inspection", "Compliance", "Compliance Requirement", "Regulatory Requirement", "Legislation"] },

  // Space
  { id: "spaceName", label: "Room name", level: "space", kind: "text", names: ["Name", "Room Name", "Space Name", "COBie.Space.Name"] },
  { id: "spaceNumber", label: "Room number", level: "space", kind: "text", names: ["Number", "Room Number", "Space Number", "COBie.Space.RoomTag"] },
  { id: "spaceCategory", label: "Space category", level: "space", kind: "text", names: ["COBie.Space.Category", "Space Type", "Room Type", "Occupancy", "Function", "Classification.Uniclass.SL.Number"] },
  { id: "department", label: "Department / zone", level: "space", kind: "text", names: ["Department", "COBie.Zone.Name", "Zone", "HVAC Zone"] },
  { id: "grossArea", label: "Gross area (m²)", level: "space", kind: "number", names: ["COBie.Space.GrossArea", "Gross Area", "Gross Floor Area", "Gross Planned Area"] },
  { id: "netArea", label: "Net area (m²)", level: "space", kind: "number", names: ["COBie.Space.NetArea", "Net Area", "Area", "Computed Area", "Net Floor Area", "Net Planned Area"] },
  { id: "usableHeight", label: "Usable height (m)", level: "space", kind: "number", names: ["COBie.Space.UsableHeight", "Usable Height", "Unbounded Height", "Height", "Ceiling Height", "Finish Ceiling Height"] },
  { id: "occupant", label: "Occupant", level: "space", kind: "text", names: ["Occupant", "Tenant", "Owner"] },
  { id: "spaceFireZone", label: "Fire compartment", level: "space", kind: "text", names: ["Fire Compartment", "Compartment", "Fire Zone", "Smoke Zone", "Smoke Compartment", "Fire Compartment Number"] },
];

// Groups of the older fields (newer ones carry theirs).
const GROUPS: [FieldGroup, string[]][] = [
  ["identity", ["tag", "serialNumber", "barCode", "assetIdentifier", "comments", "typeMark", "typeDescription"]],
  ["product", ["manufacturer", "model", "modelReference", "classification", "classificationTitle", "assetType", "supplier", "nominalLength", "nominalWidth", "nominalHeight", "shape", "size", "color", "finish", "grade", "material", "constituents", "features", "accessibilityPerformance", "codePerformance", "sustainabilityPerformance", "url"]],
  ["lifecycle", ["installationDate", "manufactureYear", "warrantyStartDate", "warrantyEndDate", "warrantyGuarantorParts", "warrantyDurationParts", "warrantyGuarantorLabor", "warrantyDurationLabor", "warrantyDurationUnit", "warrantyDescription", "expectedLife", "durationUnit", "endOfLife", "replacementCost", "condition", "status"]],
  ["maintenance", ["ppmTask", "ppmFrequency", "ppmFrequencyUnit", "ppmDuration"]],
  ["location", ["space", "systemName", "systemClassification", "systemType", "servedBy", "serves"]],
  ["electrical", ["panel", "panelName", "circuit"]],
];
for (const f of FIELDS) {
  if (f.group) continue;
  f.group = f.level === "space" ? "room" : (GROUPS.find(([, ids]) => ids.includes(f.id))?.[0] ?? "identity");
}

export const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  identity: "Identity",
  product: "Product",
  lifecycle: "Dates, warranty and life",
  maintenance: "Maintenance",
  location: "Location, systems and serving",
  electrical: "Electrical",
  technical: "MEP technical data",
  fire: "Fire and life safety",
  cafm: "Asset management",
  room: "Rooms",
};

/** Names compared without case, spaces or punctuation: "COBie.Type.Manufacturer" ~ "cobietypemanufacturer". */
export function normaliseName(name: string): string {
  // "Maintanance" and "Maintainance" are common misspellings in project parameters.
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/maint[ae]i?nance/g, "maintenance");
}

/** A property name's unit in brackets at its end: "Expected Lifetime (Years)" is "Expected Lifetime" in years. */
export function nameUnit(name: string): { base: string; unit: string } | null {
  const m = /^(.*\S)\s*\(([^()\s]{1,12})\)\s*$/.exec(name);
  return m ? { base: m[1], unit: m[2] } : null;
}

// Navisworks tabs and Revit groups that hold type parameters, instance parameters, or neither (best first).
const TYPE_GROUPS = ["revit type", "type", "identity data", "other", "element", "data", "general", "text"];
const COMPONENT_GROUPS = ["element", "identity data", "other", "item", "data", "general", "text", "revit type"];
// Groups that describe a related object rather than the element itself (its material, level, host, room…).
const FOREIGN_GROUP = /^(.*material.*|lcoa.*|base constraint|top constraint|base level|top level|reference level|schedule level|host|phase|phase id|design option|level|workset|distribution system|system type|pipe segment|pipesegment|mepsystem|walltype|hyperlinks|item|.*constraint|.*level)$/i;

/** How well a property group suits a field level: lower is better; Infinity rejects it. */
export function groupRank(group: string, level: FieldLevel, fieldId: string): number {
  const g = group.toLowerCase().trim();
  // Revit's own group for an element's materials.
  if (g === "materials and finishes") return fieldId === "material" || fieldId === "finish" || fieldId === "color" ? 2 : Infinity;
  // A related object's tab carries its own Description, Manufacturer… (the material's, the system type's).
  if (FOREIGN_GROUP.test(g)) {
    // Navisworks' Item tab names the element's own material; system fields live on system tabs.
    if (fieldId === "material" && g === "item") return 8;
    if ((fieldId === "systemType" || fieldId === "systemName" || fieldId === "systemClassification") && /system/.test(g)) return 5;
    return Infinity;
  }
  const order = level === "type" ? TYPE_GROUPS : level === "space" ? ["element", "identity data", "dimensions", "other", "constraints", "data", "general", "room", "space"] : COMPONENT_GROUPS;
  const i = order.indexOf(g);
  return i >= 0 ? i : order.length;
}

// ---------------------------------------------------------------------------
// Values

const PLACEHOLDER = /^(?:n\/?a|na|none|null|nil|-+|\.+|_+|tbc|tbd|tba|to be (?:confirmed|determined|advised)|unknown|not known|not applicable|\?+|0|default|xx+|\*+)$/i;
const JUNK = /load (?:accompanying )?type catalog|not a type|please (?:load|select|enter|record|refer|provide|insert|add|fill)|record(?:ed)? (?:on|at|during|after) (?:commissioning|handover|installation|site)|to be (?:recorded|provided|filled|updated)/i;
// A zero, bare or with a unit ("0.00", "0 VA", "0.00 kW", "0.0 L/s", "0.00%"): a default nobody filled in.
const ZERO = /^[-+]?0+(?:[.,]0+)?\s*(?:%|°|[A-Za-z][A-Za-z0-9/²³·.\-]*)?$/;

/** Text of a property value, empty for placeholders ("n/a", "TBC", "-", "Please load type catalog"). */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? String(Math.round(value * 1e6) / 1e6) : "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || PLACEHOLDER.test(text) || JUNK.test(text) || ZERO.test(text)) return "";
  return text;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function validDate(y: number, m: number, d: number): string {
  // Before 1920 is a placeholder (COBie's 1900-12-31, and 1905-12-31 from it read as a serial day); 1999-12-31 a sentinel.
  if (y < 1920 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31 || (y === 1999 && m === 12 && d === 31)) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A date as ISO "YYYY-MM-DD" (or "YYYY-MM", "YYYY" when that is all there is).
 * Day-first when ambiguous (dd/mm/yyyy, as in most of the world outside the US).
 */
export function parseDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    // A year, or an Excel serial day (1 = 1900-01-01).
    if (value >= 1920 && value <= 2200 && Number.isInteger(value)) return String(value);
    if (value > 20000 && value < 80000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
      return validDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    return "";
  }
  // A time of day after the date is dropped ("15/03/2021 00:00:00", "2021-03-15T10:00:00Z").
  const text = cleanText(value).replace(/(?<=\d)-?[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]M)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i, "");
  if (!text) return "";
  // An Excel serial day written out as text (dates kept as numbers in a spreadsheet the model was filled from).
  if (/^\d{5}$/.test(text)) return parseDate(Number(text));
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(text);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(text);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const a = +m[1],
      b = +m[2];
    // Day first, unless that cannot be (13/05 is day-first either way; 05/13 must be month-first).
    return a > 12 ? validDate(y, b, a) : b > 12 ? validDate(y, a, b) : validDate(y, b, a);
  }
  m = /^(\d{1,2})[\s\-]+([A-Za-z]{3,9})[\s\-,]+(\d{4}|\d{2})$/.exec(text);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (month) return validDate(y, month, +m[1]);
  }
  m = /^([A-Za-z]{3,9})[\s\-]+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) return validDate(+m[3], month, +m[2]);
  }
  m = /^([A-Za-z]{3,9})[\s\-,]+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month && +m[2] >= 1920 && +m[2] <= 2200) return `${m[2]}-${pad(month)}`;
  }
  m = /^(\d{1,2})[/.\-](\d{4})$/.exec(text);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1920 && +m[2] <= 2200) return `${m[2]}-${pad(+m[1])}`;
  m = /^(\d{4})$/.exec(text);
  if (m && +m[1] >= 1920 && +m[1] <= 2200) return m[1];
  return "";
}

/** The year of a date-like value (or a bare year). */
export function parseYear(value: unknown): string {
  const date = parseDate(value);
  if (date) return date.slice(0, 4);
  const text = cleanText(value);
  const m = /\b(19[2-9]\d|2[01]\d{2})\b/.exec(text);
  return m ? m[1] : "";
}

export type DurationUnit = "year" | "month" | "week" | "day" | "hour" | "minute";

const UNIT_WORDS: [RegExp, DurationUnit][] = [
  [/^(y|yr|yrs|year|years|annual|annually|yearly|pa|p\.a\.)$/i, "year"],
  [/^(m|mo|mon|mos|month|months|monthly|mth|mths)$/i, "month"],
  [/^(w|wk|wks|week|weeks|weekly)$/i, "week"],
  [/^(d|day|days|daily)$/i, "day"],
  [/^(h|hr|hrs|hour|hours|hourly)$/i, "hour"],
  [/^(min|mins|minute|minutes)$/i, "minute"],
];

const NAMED_FREQUENCY: [RegExp, number, DurationUnit][] = [
  [/^(daily|every day)$/i, 1, "day"],
  [/^(weekly|every week)$/i, 1, "week"],
  [/^(fortnightly|bi-?weekly|every (two|2) weeks)$/i, 2, "week"],
  [/^(monthly|every month)$/i, 1, "month"],
  [/^(bi-?monthly|every (two|2) months)$/i, 2, "month"],
  [/^(quarterly|every (three|3) months)$/i, 3, "month"],
  [/^(four-?monthly|every (four|4) months)$/i, 4, "month"],
  [/^(half[- ]?yearly|semi[- ]?annual(ly)?|six[- ]?monthly|bi-?annual(ly)?|every (six|6) months)$/i, 6, "month"],
  [/^(yearly|annual(ly)?|every year|once a year)$/i, 1, "year"],
  [/^(biennial(ly)?|every (two|2) years)$/i, 2, "year"],
];

/**
 * A duration as a number and unit: "15 years", "180 months", "6M", "Quarterly",
 * or a bare number (unit from the field's unit column or `fallbackUnit`).
 */
export function parseDuration(value: unknown, fallbackUnit: DurationUnit | "" = ""): { value: number; unit: DurationUnit | "" } | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return { value, unit: fallbackUnit };
  const text = cleanText(value);
  if (!text) return null;
  for (const [re, n, unit] of NAMED_FREQUENCY) if (re.test(text)) return { value: n, unit };
  const iso = isoDurationValue(text);
  if (iso) return iso;
  const m = /^(\d+(?:[.,]\d+)?)\s*-?\s*([A-Za-z.]*)\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!(n > 0)) return null;
  const word = m[2].replace(/\.$/, "");
  if (!word) return { value: n, unit: fallbackUnit };
  for (const [re, unit] of UNIT_WORDS) if (re.test(word)) return { value: n, unit };
  return null;
}

/** An ISO 8601 duration (P15Y, P18M, P1Y6M, P2W, PT4H) in its largest whole unit. */
function isoDurationValue(text: string): { value: number; unit: DurationUnit } | null {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i.exec(text.replace(/\s+/g, ""));
  if (!m || text.length < 3) return null;
  const [, y, mo, w, d, h, mi] = m.map((x) => (x === undefined ? 0 : Number(x))) as number[];
  if (y || mo) return w || d || h || mi ? { value: Math.round((y * 365.25 + mo * 30.4375 + w * 7 + d) * 1000) / 1000, unit: "day" } : mo ? { value: y * 12 + mo, unit: "month" } : { value: y, unit: "year" };
  if (w && !d && !h && !mi) return { value: w, unit: "week" };
  if (w || d) return h || mi ? { value: Math.round(((w * 7 + d) * 24 + h + mi / 60) * 1000) / 1000, unit: "hour" } : { value: w * 7 + d, unit: "day" };
  if (h) return mi ? { value: h * 60 + mi, unit: "minute" } : { value: h, unit: "hour" };
  if (mi) return { value: mi, unit: "minute" };
  return null;
}

export function unitWord(unit: DurationUnit | ""): string {
  return unit ? `${unit[0].toUpperCase()}${unit.slice(1)}` : "";
}

/** A duration unit from text ("Years", "months", "yr"). */
export function parseUnit(value: unknown): DurationUnit | "" {
  const text = cleanText(value);
  for (const [re, unit] of UNIT_WORDS) if (re.test(text)) return unit;
  if (/^years?$/i.test(text)) return "year";
  return "";
}

/** Years in a duration (for end-of-life arithmetic), or null. */
export function durationYears(d: { value: number; unit: DurationUnit | "" } | null): number | null {
  if (!d) return null;
  switch (d.unit) {
    case "year":
    case "":
      return d.value;
    case "month":
      return d.value / 12;
    case "week":
      return d.value / 52.1775;
    case "day":
      return d.value / 365.25;
    default:
      return null;
  }
}

/** ISO 8601 duration for IfcDuration ("P15Y", "P6M"). */
export function isoDuration(d: { value: number; unit: DurationUnit | "" } | null): string {
  if (!d || !(d.value > 0)) return "";
  const v = Math.round(d.value * 1000) / 1000;
  switch (d.unit) {
    case "year":
    case "":
      return `P${v}Y`;
    case "month":
      return `P${v}M`;
    case "week":
      return `P${v}W`;
    case "day":
      return `P${v}D`;
    case "hour":
      return `PT${v}H`;
    case "minute":
      return `PT${v}M`;
  }
}

/** A plain number from a value ("1,250.00", "AED 2,300", 12), or null. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value);
  if (!text) return null;
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
