// Room types for the rooms of a plan: the kinds of rooms most buildings
// have, each with the Uniclass 2015 Spaces/locations (SL) code it most often
// takes. A type comes from the room's name (common words and abbreviations in
// several languages), from the on-device assistant for names these rules do
// not know, or from the user. Codes are suggestions, to be checked.
//
// Uniclass 2015 codes and titles: NBS, from the published SL table (January
// 2022 edition). NBS publishes Uniclass free of charge under CC BY-ND 4.0;
// the codes and titles are used as published.

export interface RoomType {
  id: string;
  label: string;
  /** Uniclass 2015 SL code and title. */
  sl: [string, string] | null;
}

const t = (id: string, label: string, code: string | null, title = ""): RoomType => ({ id, label, sl: code ? [code, title] : null });

export const ROOM_TYPES: RoomType[] = [
  t("office", "Office", "SL_20_15_59", "Offices"),
  t("open_office", "Open-plan office", "SL_20_15_61", "Open-plan offices"),
  t("meeting", "Meeting room", "SL_20_15_50", "Meeting rooms"),
  t("conference", "Conference room", "SL_25_70_13", "Conference rooms"),
  t("reception", "Reception", "SL_20_15_71", "Reception areas"),
  t("waiting", "Waiting room", "SL_90_20_96", "Waiting rooms"),
  t("security", "Security office", "SL_20_85_80", "Security offices"),
  t("control", "Control room", "SL_90_90_15", "Control rooms"),
  t("corridor", "Corridor", "SL_90_10_15", "Corridors"),
  t("lobby", "Lobby / entrance hall", "SL_90_10_27", "Entrance halls"),
  t("hallway", "Hall / foyer (dwelling)", "SL_90_10_36", "Hallways"),
  t("vestibule", "Vestibule / airlock", "SL_90_10_94", "Vestibules"),
  t("stair", "Stair", "SL_90_10_87", "Stairways"),
  t("lift", "Lift", "SL_90_10_47", "Lifts"),
  t("toilet", "Toilet", "SL_35_80_89", "Toilets"),
  t("accessible_toilet", "Accessible toilet", "SL_35_80_03", "Accessible toilets"),
  t("bathroom", "Bathroom", "SL_35_80_08", "Bathrooms"),
  t("shower", "Shower", "SL_35_80_80", "Showers"),
  t("changing", "Changing room", "SL_90_20_13", "Changing rooms"),
  t("locker", "Locker room", "SL_90_50_48", "Locker rooms"),
  t("pantry", "Pantry / kitchenette", "SL_35_60_45", "Kitchenettes"),
  t("kitchen", "Kitchen (dwelling)", "SL_45_10_23", "Domestic kitchens"),
  t("commercial_kitchen", "Commercial kitchen", "SL_35_60_14", "Commercial kitchens"),
  t("dining", "Dining room (dwelling)", "SL_45_10_22", "Domestic dining rooms"),
  t("canteen", "Canteen / restaurant", "SL_40_20_42", "Indoor dining rooms"),
  t("staff_room", "Staff room / break room", "SL_90_20_85", "Staff rooms"),
  t("cloakroom", "Cloakroom", "SL_90_20_14", "Cloakrooms"),
  t("prayer", "Prayer room", "SL_25_90_65", "Prayer rooms"),
  t("first_aid", "First aid room", "SL_35_10_31", "First aid rooms"),
  t("ablution", "Ablution area", "SL_35_80", "Sanitary spaces"),
  t("store", "Store", "SL_90_50_84", "Storage rooms"),
  t("cleaner", "Cleaner's store", "SL_90_50_16", "Cleaners' stores"),
  t("archive", "Archive / records", "SL_25_70_02", "Archives"),
  t("refuse", "Refuse store", "SL_50_40_72", "Refuse storage space"),
  t("wardrobe", "Walk-in wardrobe / dressing", "SL_90_50_93", "Walk-in wardrobes"),
  t("plant", "Plant room", "SL_90_90_64", "Plant rooms"),
  t("electrical", "Electrical / switch room", "SL_90_90_85", "Switch rooms"),
  t("comms", "Communications room", "SL_75_10_21", "Communications equipment rooms"),
  t("server", "Server room", "SL_90_90_77", "Server rooms"),
  t("lift_machine", "Lift machine room", "SL_90_90_48", "Lift machine rooms"),
  t("shaft", "Services shaft / riser", "SL_90_90_78", "Services shafts"),
  t("bedroom", "Bedroom", "SL_45_10_09", "Bedrooms"),
  t("living", "Living room / majlis", "SL_45_10_49", "Living rooms"),
  t("kitchen_dining", "Kitchen-dining room", "SL_45_10_44", "Kitchen-dining rooms"),
  t("utility", "Utility / laundry", "SL_45_10_93", "Utility rooms"),
  t("study", "Study", "SL_25_10_84", "Study spaces"),
  t("balcony", "Balcony / terrace", "SL_45_10_06", "Balconies"),
  t("classroom", "Classroom", "SL_25_10_14", "Classrooms"),
  t("lecture", "Lecture theatre", "SL_25_10_47", "Lecture theatres"),
  t("laboratory", "Laboratory", "SL_25_30", "Scientific and laboratory spaces"),
  t("library", "Library", "SL_25_70_47", "Library rooms"),
  t("consulting", "Consulting room", "SL_35_10_15", "Consulting rooms"),
  t("treatment", "Treatment room", "SL_35_10_53", "Medical treatment rooms"),
  t("ward", "Ward", "SL_35_10_96", "Wards"),
  t("gym", "Gym", "SL_42_40_35", "Gymnasiums"),
  t("auditorium", "Auditorium / hall", "SL_40_60_05", "Auditoriums"),
  t("retail", "Shop / retail", "SL_20_50", "Commercial spaces"),
  t("workshop", "Workshop", "SL_30_60_50", "Maintenance workshops"),
  t("warehouse", "Warehouse", "SL_30_90_96", "Warehouse spaces"),
  t("loading", "Loading bay", "SL_30_90_48", "Loading docks"),
  t("parking", "Car park", "SL_80_45_40", "Indoor vehicle parking spaces"),
  t("garage", "Garage", "SL_90_50_33", "Garages"),
  t("cycle_store", "Cycle store", "SL_90_50_17", "Cycle storage spaces"),
  t("other", "Other", null),
];

const BY_ID = new Map(ROOM_TYPES.map((r) => [r.id, r]));

export function roomType(id: string | null | undefined): RoomType | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Lower case, accents removed, punctuation to spaces ("Büro 1.02" -> "buro 1 02"). */
export function normaliseName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/(\p{L})[’'`´](\p{L})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Most specific first. Words are matched on the normalised name with word
// boundaries; several languages (English, German, French, Spanish,
// Portuguese, Italian, Dutch, Arabic and common Gulf transliterations).
const RAW_RULES: [string, RegExp][] = [
  ["accessible_toilet", /\b(accessible|disabled|handicap\w*|ada|phc|pmr|barrierefrei|behinderten\w*|minusvalidos?|discapacitados?)\s*(wc|toilets?|lavatory|lav|restroom|aseo|bano|toilette)\b|\b(awc|dwc|dis wc|acc wc|wc pmr|wc minusvalidos?)\b/],
  ["lobby", /\b(lift|lifts|elevator|stair|stairs|sky)\s*lobby\b/],
  ["lift_machine", /\b(lift|elevator)\s*(motor|machine|mc)\s*(room|rm)?\b|\b(lmr|emr)\b|\bmaschinenraum\b/],
  ["shaft", /\b(riser|risers|shaft|shafts|duct|ducts|schacht|gaine|gaines|patinillo|cavedio)\b/],
  ["lift", /\b(lift|lifts|elevator|elevators|aufzug|fahrstuhl|ascenseur|ascensor|ascensores|elevador|ascensore|liften|مصعد)\b/],
  ["stair", /\b(stair|stairs|staircase|stairway|stairwell|treppe|treppenhaus|treppenraum|escalier|escaliers|escalera|escaleras|escada|escadas|scala|scale|trappenhuis|درج|سلم)\b/],
  ["server", /\b(server|servers|data centre|data center|datacenter|serverraum|salle serveur|sala de servidores|cpd)\b/],
  ["comms", /\b(comms|comm room|communications?|telecom\w*|tel room|ter|idf|mdf|bdf|it room|ict room|network room|ser|fernmelde\w*|edv)\b/],
  ["electrical", /\b(electrical|elec|elect|switch room|switchroom|switchgear|lv room|hv room|mv room|transformer|transformers|substation|sub station|ups|ups room|battery|batteries|battery room|smdb|mdb|emdb|db room|elektro\w*|local electrique|tgbt|cuarto electrico|sala electrica|cabina electrica|quadri elettrici|غرفة الكهرباء)\b/],
  ["plant", /\b(plant|plantroom|plant room|mechanical|mech|ahu|fahu|hvac|boiler|boiler room|chiller|chillers|pump|pumps|pump room|generator|genset|tank room|sprinkler|fire pump|technik|technikraum|technikzentrale|haustechnik|hausanschluss\w*|heizraum|heizung|chaufferie|local technique|cuarto de maquinas|sala de maquinas|sala tecnica|locale tecnico|centrale termica|technische ruimte|غرفة المعدات)\b/],
  ["control", /\b(control room|control centre|control center|command centre|command center|fire command|fire cmd|bms|fcc|fire control|security control|cctv|monitoring room|leitwarte|leitstand)\b/],
  ["security", /\b(security|guard|guards|guardhouse|guard room|sicherheit|pforte|pfortner|loge|conserjeria|portaria|vigilanza|beveiliging)\b/],
  ["first_aid", /\b(first aid|sick bay|sickbay|sick room|sick rm|nurse|nurses|infirmary|erste hilfe|sanitatsraum|infirmerie|enfermeria|primeiros socorros|infermeria|ehbo)\b/],
  ["prayer", /\b(prayer|musalla|musallah|mussala|masjid|mosque|chapel|multi faith|multifaith|quiet room|gebetsraum|salle de priere|sala de oracion|مصلى)\b/],
  ["ablution", /\b(ablution|ablutions|wudu|wudhu|وضوء)\b/],
  ["changing", /\b(changing|change room|change rooms|umkleide\w*|vestiaire|vestiaires|vestuario|vestuarios|spogliatoio|spogliatoi|kleedruimte\w*)\b/],
  ["shower", /\b(shower|showers|dusche|duschen|douche|douches|ducha|duchas|chuveiro|doccia|docce)\b/],
  ["locker", /\b(locker|lockers)\b/],
  ["toilet", /\b(wc|wcs|w c|toilet|toilets|lavatory|lavatories|lav|lavs|restroom|restrooms|washroom|washrooms|powder room|powder|cloakroom wc|gents|ladies|herren|damen|toilette|toiletten|aborte|sanitaires|sanitaire|aseo|aseos|servicios|sanitarios|banheiro|banheiros|bagni|servizi|dames|heren|دورة مياه|حمام)\b/],
  ["bathroom", /\b(bath|bathroom|bathrooms|ensuite|en suite|bad|badezimmer|salle de bain|salle de bains|salle d eau|sdb|bano|banos|casa de banho|bagno|badkamer|hammam)\b/],
  ["cleaner", /\b(cleaner|cleaners|cleaning|janitor|jan|housekeeping|putzraum|reinigung\w*|local menage|local entretien|cuarto de limpieza|schoonmaak\w*)\b/],
  ["refuse", /\b(refuse|waste|garbage|trash|bin store|bins|rubbish|recycling|mull\w*|abfall\w*|poubelles|ordures|basura|basuras|residuos|rifiuti|afval)\b/],
  ["cycle_store", /\b(cycle|cycles|bicycle|bicycles|bike|bikes|fahrrad\w*|local velos|bicicleta\w*|bici|fietsen\w*)\b/],
  ["archive", /\b(archive|archives|records|file room|filing|archiv|archivo|arquivo|archivio|archief)\b/],
  ["wardrobe", /\b(wardrobe|walk in|dressing|dress|closet|wic|ankleide|vestidor|cabina armadio)\b/],
  ["store", /\b(store|stores|storage|stor|str|stg|storeroom|storerooms|luggage|linen|linen store|lager|abstell\w*|rangement|reserve|debarras|depot|almacen|almacenaje|bodega|trastero|deposito|arrecadacao|despensa|magazzino|ripostiglio|berging|opslag|مخزن)\b/],
  ["commercial_kitchen", /\b(commercial kitchen|main kitchen|production kitchen|catering kitchen|kitchen prep|prep|preparation|scullery|grosskuche|cuisine centrale|cocina industrial|cucina industriale)\b/],
  ["kitchen_dining", /\b(kitchen\s*(and|&)?\s*dining|kitchen dining|dining\s*(and|&)?\s*kitchen|wohnkuche|kuche essen)\b/],
  ["pantry", /\b(pantry|pantries|kitchenette|tea point|teapoint|tea room|tea|brew|coffee point|teekuche|tisanerie|copa|cocineta|angolo cottura)\b/],
  ["kitchen", /\b(kitchen|kitchens|kuche|cuisine|cocina|cozinha|cucina|keuken|matbakh|مطبخ)\b/],
  ["canteen", /\b(canteen|cafeteria|cafe|restaurant|food court|mess|dining hall|servery|kantine|mensa|cantine|restaurante|comedor de personal|ristorante|refettorio|bar)\b/],
  ["dining", /\b(dining|dinning|essen|essbereich|esszimmer|salle a manger|comedor|sala de jantar|sala da pranzo|eetkamer)\b/],
  ["staff_room", /\b(staff room|staffroom|break room|breakroom|breakout|break out|staff lounge|teachers room|teachers|lehrerzimmer|sala de profesores|sala profesores|salle des professeurs|pausenraum|aufenthaltsraum|salle de pause|sala de descanso)\b/],
  ["meeting", /\b(meeting|mtg|huddle|focus room|sala de juntas|besprechung\w*|sitzung\w*|reunion|reunions|salle de reunion|sala de reuniones|sala de reuniao|sala riunioni|riunioni|vergader\w*|اجتماعات)\b/],
  ["conference", /\b(conference|conf|boardroom|board room|training room|konferenz\w*|salle de conference|sala de conferencias|sala conferenze|seminar\w*)\b/],
  ["reception", /\b(reception|recep|front desk|empfang|accueil|recepcion|recepcao|ricevimento|receptie|استقبال)\b/],
  ["waiting", /\b(waiting|warte\w*|salle d attente|sala de espera|sala d attesa|wachtruimte|wachtkamer|انتظار)\b/],
  ["auditorium", /\b(auditorium|theatre|theater|cinema|multipurpose hall|multi purpose hall|mph|sports hall|assembly hall|function hall|ballroom|saal|salle polyvalente|salon de actos|auditorio)\b/],
  ["lobby", /\b(lobby|entrance|entry|entrance hall|main hall|atrium|eingang\w*|eingangshalle|hall d entree|entree|vestibulo|entrada|ingresso|atrio|inkom|ingang|مدخل)\b/],
  ["vestibule", /\b(vestibule|airlock|air lock|windfang|sas|cortavientos|bussola)\b/],
  ["corridor", /\b(corridor|corridors|corr|cor|passage|passageway|circulation|circ|walkway|flur|gang|korridor|couloir|degagement|pasillo|corredor|corridoio|disimpegno|ممر)\b/],
  ["hallway", /\b(hall|hallway|landing|foyer|diele|vorraum|recibidor|hal|دهليز)\b/],
  ["garage", /\b(garage|carport|garaje|garagem)\b/],
  ["parking", /\b(parking|car park|carpark|parkhaus|tiefgarage|stationnement|aparcamiento|estacionamento|parcheggio|parkeer\w*)\b/],
  ["loading", /\b(loading|loading bay|loading dock|delivery|deliveries|anlieferung|quai de chargement|muelle de carga)\b/],
  ["warehouse", /\b(warehouse|stockroom|lagerhalle|entrepot|magazijn)\b/],
  ["workshop", /\b(workshop|work shop|werkstatt|atelier|taller|officina|werkplaats)\b/],
  ["laboratory", /\b(lab|labs|laboratory|laboratories|labor|laboratoire|laboratorio)\b/],
  ["library", /\b(library|bibliothek|bibliotheque|biblioteca|bibliotheek|مكتبة)\b/],
  ["lecture", /\b(lecture|lecture theatre|lecture hall|horsaal|amphitheatre|amphi|aula magna)\b/],
  ["classroom", /\b(classroom|class|creche|nursery school|kindergarten|klassenzimmer|klassenraum|salle de classe|aula|sala de aula|lokaal)\b/],
  ["gym", /\b(gym|gymnasium|fitness|turnhalle|fitnessraum|salle de sport|gimnasio|ginasio|palestra|sportzaal)\b/],
  ["ward", /\b(ward|patient room|bettenzimmer|chambre patient|habitacion paciente|degenza)\b/],
  ["consulting", /\b(consulting|consult|consultation|examination|exam room|doctor|behandlungsraum|untersuchung\w*|consultorio|ambulatorio|spreekkamer)\b/],
  ["treatment", /\b(treatment|therapy|procedure room|behandlung|soins|tratamiento|trattamento)\b/],
  ["retail", /\b(shop|shops|retail|kiosk|boutique|laden|geschaft|magasin|tienda|loja|negozio|winkel)\b/],
  ["utility", /\b(utility|laundry|laundries|mud room|mudroom|boot room|hwr|waschkuche|hauswirtschaft\w*|buanderie|cellier|lavadero|lavanderia|bijkeuken|غسيل)\b/],
  ["study", /\b(study|home office|arbeitszimmer|estudio|studeerkamer)\b/],
  ["balcony", /\b(balcony|balconies|terrace|terraces|veranda|verandah|patio|deck|loggia|balkon|terrasse|balcon|terraza|varanda|terrazzo|balcone|بلكونة|شرفة)\b/],
  ["bedroom", /\b(bed|bedroom|bedrooms|master bedroom|guest room|guest|guests|maid|maids|housemaid|maid s room|driver|drivers|driver s room|nanny|bedrm|br|schlafzimmer|schlafen|kinderzimmer|gastezimmer|ghurfat nawm|chambre|chambres|dormitorio|dormitorios|habitacion|quarto|suite|camera da letto|slaapkamer|غرفة نوم|غرفة خادمة|غرفة سائق)\b/],
  ["living", /\b(living|lounge|family|family room|majlis|majles|diwaniya|diwaniyah|diwan|sitting|drawing room|snug|den|wohnzimmer|wohnen|salon|sejour|sala de estar|estar|sala|soggiorno|salotto|woonkamer|مجلس|صالة|معيشة)\b/],
  ["open_office", /\b(open plan|open office|workspace|work area|workstation|workstations|hot desk|hot desking|hotdesk|grossraumburo|plateau|open space|openspace)\b/],
  ["office", /\b(office|offices|ofc|off|offc|ofice|pa|executive|manager|director|ceo|admin|administration|hr|finance|accounts|buro|bureau|bureaux|oficina|despacho|escritorio|ufficio|uffici|kantoor|مكتب)\b/],
];

// JavaScript's \b only knows ASCII letters: a word boundary for any script.
const BOUNDARY = "(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))";
const RULES: [string, RegExp][] = RAW_RULES.map(([id, re]) => [id, new RegExp(re.source.replace(/\\b/g, BOUNDARY), "u")]);

/**
 * The room type a room's name (and number) suggests, or null when the name
 * says nothing these rules know. Room numbers alone say nothing.
 */
export function roomTypeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = normaliseName(name);
  if (!/\p{L}/u.test(n)) return null;
  const byRules = (text: string) => {
    for (const [id, re] of RULES) if (re.test(text)) return id;
    return null;
  };
  // As written, then with the letters text recognition misreads as digits ("0FFICE", "L1FT"), then words one typing slip away.
  return byRules(n) ?? byRules(ocrLetters(n, "i")) ?? byRules(ocrLetters(n, "l")) ?? byFuzzyWord(n);
}

/** Digits inside words read as the letters they look like: 0 o, 1 i or l, 5 s, 8 b. */
function ocrLetters(n: string, one: "i" | "l"): string {
  return n
    .split(" ")
    .map((w) => (/\p{L}/u.test(w) && /\d/.test(w) && !/^\d+[a-z]?$/.test(w) ? w.replace(/0/g, "o").replace(/1/g, one).replace(/5/g, "s").replace(/8/g, "b") : w))
    .join(" ");
}

// Words that name a room type on their own, for names with a typing slip ("MEETNG", "TOLET", "KITCHFN").
const WORDS: [string, string][] = [
  ["office", "office"], ["meeting", "meeting"], ["conference", "conference"], ["reception", "reception"], ["waiting", "waiting"], ["security", "security"],
  ["corridor", "corridor"], ["lobby", "lobby"], ["entrance", "lobby"], ["hallway", "hallway"], ["staircase", "stair"], ["stairs", "stair"], ["elevator", "lift"],
  ["toilet", "toilet"], ["lavatory", "toilet"], ["washroom", "toilet"], ["restroom", "toilet"], ["bathroom", "bathroom"], ["shower", "shower"], ["changing", "changing"], ["locker", "locker"],
  ["pantry", "pantry"], ["kitchen", "kitchen"], ["kitchenette", "pantry"], ["canteen", "canteen"], ["cafeteria", "canteen"], ["restaurant", "canteen"], ["dining", "dining"],
  ["prayer", "prayer"], ["storage", "store"], ["storeroom", "store"], ["cleaner", "cleaner"], ["janitor", "cleaner"], ["archive", "archive"], ["refuse", "refuse"],
  ["electrical", "electrical"], ["switchroom", "electrical"], ["server", "server"], ["communications", "comms"], ["mechanical", "plant"], ["plantroom", "plant"],
  ["bedroom", "bedroom"], ["living", "living"], ["lounge", "living"], ["laundry", "utility"], ["utility", "utility"], ["study", "study"], ["balcony", "balcony"], ["terrace", "balcony"],
  ["wardrobe", "wardrobe"], ["dressing", "wardrobe"], ["classroom", "classroom"], ["laboratory", "laboratory"], ["library", "library"], ["workshop", "workshop"],
  ["warehouse", "warehouse"], ["parking", "parking"], ["garage", "garage"], ["auditorium", "auditorium"], ["gymnasium", "gym"],
];

/** Edit distance with swaps (Damerau-Levenshtein, restricted), stopping early past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

function byFuzzyWord(n: string): string | null {
  for (const w of n.split(" ")) {
    if (w.length < 5 || /\d/.test(w)) continue;
    const max = w.length >= 9 ? 2 : 1;
    let best: string | null = null;
    let bestD = max + 1;
    for (const [word, id] of WORDS) {
      const dd = distance(w, word, max);
      if (dd < bestD) {
        bestD = dd;
        best = id;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Types from the rooms' names, for rooms the user or the assistant has not typed; names that say nothing leave no type. */
export function typeRoomsByName<R extends { name: string | null; type?: string | null; typeSource?: "name" | "assistant" | "user" | null }>(rooms: R[]): R[] {
  return rooms.map((r) => {
    if (r.typeSource === "user" || r.typeSource === "assistant") return r;
    const type = roomTypeFromName(r.name);
    return type ? { ...r, type, typeSource: "name" as const } : { ...r, type: null, typeSource: null };
  });
}

/** "SL_20_15_59: Offices" */
export function slText(type: RoomType | null): string {
  return type?.sl ? `${type.sl[0]}: ${type.sl[1]}` : "";
}

// ---------------------------------------------------------------------------
// The assistant's part: names the rules do not know (abbreviations, other
// languages, misread text), judged with the room's size, doors and windows.

export interface RoomForTyping {
  /** 1-based, as the assistant sees it. */
  n: number;
  name: string;
  number: string | null;
  /** Square metres, or null without a scale. */
  area: number | null;
  doors: number;
  windows: number;
}

/** Hints for the types that are easily mixed up. */
const HINTS: Record<string, string> = {
  pantry: "tea point or small kitchen in a workplace",
  kitchen: "kitchen of a home",
  commercial_kitchen: "kitchen of a restaurant, hotel, school or canteen",
  hallway: "hall or foyer inside a home",
  lobby: "lobby or entrance hall of a building",
  dining: "dining room of a home",
  canteen: "staff canteen, cafeteria, restaurant",
  living: "living room, lounge, family room, majlis",
  bedroom: "bedroom, including maid's, driver's and guest rooms",
  plant: "mechanical plant, AHU, pumps, boilers, chillers, generators",
  electrical: "switch room, LV/HV room, distribution boards",
  comms: "telecom, IT, IDF/MDF rooms",
  shaft: "service riser, duct or shaft",
  ablution: "washing area for prayer (wudu)",
  other: "none of these, or the name says nothing about the use",
};

function roomLines(rooms: RoomForTyping[]): string {
  return rooms
    .map((r) => {
      const parts = [`"${r.name.replace(/"/g, "'")}"`];
      if (r.number) parts.push(`number ${r.number}`);
      if (r.area !== null) parts.push(`${r.area < 10 ? r.area.toFixed(1) : Math.round(r.area)} m²`);
      parts.push(`${r.doors} door${r.doors === 1 ? "" : "s"}`, `${r.windows} window${r.windows === 1 ? "" : "s"}`);
      return `${r.n}: ${parts.join(", ")}`;
    })
    .join("\n");
}

const TYPING_EXAMPLE: { rooms: RoomForTyping[]; answer: Record<string, { english: string; type: string }> } = {
  rooms: [
    { n: 1, name: "MTG RM 2", number: null, area: 16, doors: 1, windows: 2 },
    { n: 2, name: "KÜCHE", number: null, area: 11, doors: 1, windows: 1 },
    { n: 3, name: "PLNT", number: null, area: 30, doors: 1, windows: 0 },
    { n: 4, name: "ARCHIV0", number: null, area: 9, doors: 1, windows: 0 },
    { n: 5, name: "SPACE 4", number: null, area: 20, doors: 2, windows: 1 },
  ],
  answer: {
    "1": { english: "meeting room", type: "meeting" },
    "2": { english: "kitchen", type: "kitchen" },
    "3": { english: "plant room", type: "plant" },
    "4": { english: "archive", type: "archive" },
    "5": { english: "unknown space", type: "other" },
  },
};

export function roomTypesTask(rooms: RoomForTyping[]): import("@/lib/ondevice/types").JsonTask {
  const ids = ROOM_TYPES.map((r) => r.id);
  const list = ROOM_TYPES.map((r) => `${r.id} = ${r.label}${HINTS[r.id] ? ` (${HINTS[r.id]})` : ""}`).join("\n");
  // One key per room, so every room gets an answer; the English name first, so the type is chosen from it.
  const keys = rooms.map((r) => String(r.n));
  return {
    label: "Suggesting room types",
    system: `You sort the rooms of a building floor plan into room types. Each room has the name written in it, which may be abbreviated, in any language or script, or misread by text recognition, and its floor area, doors and windows. For each room give english: what the room is, in two or three plain English words (expand abbreviations, translate, correct misread letters), then type: the one type id from the list that fits best (other when none fits or the name says nothing about the room's use). Answer only with compact JSON on one line.\n\nRoom types (id = meaning):\n${list}`,
    examples: [{ user: roomLines(TYPING_EXAMPLE.rooms), answer: JSON.stringify(TYPING_EXAMPLE.answer) }],
    user: roomLines(rooms),
    schema: {
      type: "object",
      properties: Object.fromEntries(
        keys.map((k) => [k, { type: "object", properties: { english: { type: "string" }, type: { type: "string", enum: ids } }, required: ["english", "type"], additionalProperties: false }]),
      ),
      required: keys,
      additionalProperties: false,
    },
    maxTokens: 40 + rooms.length * 40,
  };
}

/** The assistant's answer: type id by room n. Its English name decides when the rules know it (they are more consistent); its type otherwise. */
export function readRoomTypes(answer: unknown, count: number): Map<number, string> {
  const out = new Map<number, string>();
  if (!answer || typeof answer !== "object") return out;
  for (const [key, value] of Object.entries(answer as Record<string, unknown>)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > count || !value || typeof value !== "object") continue;
    const v = value as { english?: unknown; type?: unknown };
    const fromEnglish = typeof v.english === "string" ? roomTypeFromName(v.english) : null;
    const type = fromEnglish ?? String(v.type ?? "");
    if (BY_ID.has(type)) out.set(n, type);
  }
  return out;
}
