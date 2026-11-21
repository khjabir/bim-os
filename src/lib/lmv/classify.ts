// Guesses an IFC class for an object that only has names: its own, those of
// its ancestors in the model tree (layer, category, family) and a few
// property values. Navisworks files carry no IFC classes of their own, so
// this is a best-effort mapping; anything unrecognised becomes a proxy.

interface Rule {
  ifcClass: string;
  pattern: RegExp;
}

// Order matters: the first match wins, so specific phrases come before general ones.
const RULES: Rule[] = [
  { ifcClass: "IFCMEMBER", pattern: /\b(mullion|transom|brac(e|ing)|truss|purlin|girt|strut)s?\b/ },
  { ifcClass: "IFCPLATE", pattern: /\b(curtain\s*panel|glazing\s*panel|cladding\s*panel)s?\b/ },
  { ifcClass: "IFCCURTAINWALL", pattern: /\bcurtain\s*(wall|system)s?\b/ },
  { ifcClass: "IFCDUCTFITTING", pattern: /\bduct\s*(fitting|accessor(y|ies))s?\b/ },
  { ifcClass: "IFCPIPEFITTING", pattern: /\b(pipe|piping)\s*(fitting|accessor(y|ies))s?\b|\b(elbow|tee|reducer|flange|coupling)s?\b/ },
  { ifcClass: "IFCCABLECARRIERSEGMENT", pattern: /\b(cable\s*(tray|ladder)|conduit|raceway)s?\b/ },
  { ifcClass: "IFCCABLESEGMENT", pattern: /\b(cable|wire|busbar)s?\b/ },
  { ifcClass: "IFCAIRTERMINAL", pattern: /\b(air\s*terminal|diffuser|grille|register)s?\b/ },
  { ifcClass: "IFCFIRESUPPRESSIONTERMINAL", pattern: /\bsprinklers?\b/ },
  { ifcClass: "IFCSANITARYTERMINAL", pattern: /\b(plumbing\s*fixture|sanitary|toilet|wc|urinal|lavatory|basin|sink|bath(tub)?|shower)s?\b/ },
  { ifcClass: "IFCLIGHTFIXTURE", pattern: /\b(light(ing)?\s*fixture|luminaire|lamp)s?\b/ },
  { ifcClass: "IFCVALVE", pattern: /\bvalves?\b/ },
  { ifcClass: "IFCPUMP", pattern: /\bpumps?\b/ },
  { ifcClass: "IFCTANK", pattern: /\b(tank|vessel)s?\b/ },
  { ifcClass: "IFCDUCTSEGMENT", pattern: /\b(duct|ductwork|flex\s*duct)s?\b/ },
  { ifcClass: "IFCPIPESEGMENT", pattern: /\b(pipe|piping|pipework|flex\s*pipe)s?\b/ },
  { ifcClass: "IFCDOOR", pattern: /\b(door|gate)s?\b/ },
  { ifcClass: "IFCWINDOW", pattern: /\b(window|skylight)s?\b/ },
  { ifcClass: "IFCSTAIR", pattern: /\b(stair|staircase|stairway)s?\b/ },
  { ifcClass: "IFCRAMP", pattern: /\bramps?\b/ },
  { ifcClass: "IFCRAILING", pattern: /\b(railing|handrail|guardrail|balustrade|top\s*rail)s?\b/ },
  { ifcClass: "IFCROOF", pattern: /\b(roof|roofing)s?\b/ },
  { ifcClass: "IFCCOVERING", pattern: /\b(ceiling|flooring|floor\s*finish|cladding|insulation|lining)s?\b/ },
  { ifcClass: "IFCFOOTING", pattern: /\b(footing|foundation|pile\s*cap|pad\s*foundation|strip\s*foundation)s?\b/ },
  { ifcClass: "IFCPILE", pattern: /\bpiles?\b/ },
  { ifcClass: "IFCCOLUMN", pattern: /\b(column|pillar|stanchion)s?\b/ },
  { ifcClass: "IFCBEAM", pattern: /\b(beam|girder|joist|lintel|rafter|structural\s*framing)s?\b/ },
  { ifcClass: "IFCSLAB", pattern: /\b(slab|floor|deck|landing)s?\b/ },
  { ifcClass: "IFCWALL", pattern: /\b(wall|partition|parapet)s?\b/ },
  { ifcClass: "IFCPLATE", pattern: /\b(plate|panel)s?\b/ },
  { ifcClass: "IFCFURNITURE", pattern: /\b(furniture|casework|desk|chair|table|cabinet|shelf|shelving|sofa|bed|wardrobe)s?\b/ },
  { ifcClass: "IFCTRANSPORTELEMENT", pattern: /\b(elevator|lift|escalator|moving\s*walk)s?\b/ },
];

function normalise(text: string) {
  return text
    .toLowerCase()
    .replace(/[_\-./\\:]+/g, " ")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const cache = new Map<string, string | null>();

function match(text: string): string | null {
  let found = cache.get(text);
  if (found === undefined) {
    const normalised = normalise(text);
    found = null;
    for (const rule of RULES) {
      if (rule.pattern.test(normalised)) {
        found = rule.ifcClass;
        break;
      }
    }
    if (cache.size > 20_000) cache.clear();
    cache.set(text, found);
  }
  return found;
}

/**
 * Picks an IFC class from candidate texts, most specific first (category
 * property, then the object's name, then its ancestors from near to far).
 */
export function guessIfcClass(candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = match(candidate);
    if (found) return found;
  }
  return "IFCBUILDINGELEMENTPROXY";
}
