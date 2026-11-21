// Reads an .ids file (IDS 1.0 XML) into the data model in ./types.

import type { IdsCardinality, IdsDocument, IdsFacet, IdsSpecification, IdsValue } from "./types";

/** Element name without its namespace prefix (xs:restriction -> restriction). */
function local(element: Element) {
  const name = element.localName || element.nodeName || "";
  const colon = name.lastIndexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function childrenOf(element: Element, name?: string): Element[] {
  const result: Element[] = [];
  for (const child of Array.from(element.children)) if (!name || local(child) === name) result.push(child);
  return result;
}

function childOf(element: Element, name: string): Element | undefined {
  return childrenOf(element, name)[0];
}

function textOf(element: Element | undefined): string | undefined {
  const text = element?.textContent?.trim();
  return text ? text : undefined;
}

function parseValue(element: Element | undefined): IdsValue | undefined {
  if (!element) return undefined;
  const simple = childOf(element, "simpleValue");
  if (simple) return { kind: "simple", value: simple.textContent?.trim() ?? "" };
  const restriction = childOf(element, "restriction");
  if (!restriction) {
    const text = textOf(element);
    return text === undefined ? undefined : { kind: "simple", value: text };
  }
  const value: Extract<IdsValue, { kind: "restriction" }> = { kind: "restriction", base: restriction.getAttribute("base") ?? undefined };
  for (const child of childrenOf(restriction)) {
    const raw = child.getAttribute("value") ?? "";
    const number = Number(raw);
    switch (local(child)) {
      case "enumeration":
        (value.enumeration ??= []).push(raw);
        break;
      case "pattern":
        (value.pattern ??= []).push(raw);
        break;
      case "minInclusive":
        value.minInclusive = number;
        break;
      case "maxInclusive":
        value.maxInclusive = number;
        break;
      case "minExclusive":
        value.minExclusive = number;
        break;
      case "maxExclusive":
        value.maxExclusive = number;
        break;
      case "length":
        value.length = number;
        break;
      case "minLength":
        value.minLength = number;
        break;
      case "maxLength":
        value.maxLength = number;
        break;
      default:
        break;
    }
  }
  return value;
}

function cardinalityOf(element: Element): IdsCardinality {
  const explicit = element.getAttribute("cardinality");
  if (explicit === "optional" || explicit === "prohibited" || explicit === "required") return explicit;
  // IDS 0.9 files used minOccurs / maxOccurs on requirement facets.
  const min = element.getAttribute("minOccurs");
  const max = element.getAttribute("maxOccurs");
  if (max === "0") return "prohibited";
  if (min === "0") return "optional";
  return "required";
}

const ANY: IdsValue = { kind: "restriction", pattern: [".*"] };

function parseFacet(element: Element, warnings: string[], specName: string): IdsFacet | null {
  const base = { cardinality: cardinalityOf(element), instructions: element.getAttribute("instructions") ?? undefined };
  switch (local(element)) {
    case "entity": {
      const name = parseValue(childOf(element, "name"));
      if (!name) {
        warnings.push(`"${specName}": an entity facet has no name and was skipped.`);
        return null;
      }
      return { ...base, type: "entity", name, predefinedType: parseValue(childOf(element, "predefinedType")) };
    }
    case "attribute": {
      const name = parseValue(childOf(element, "name"));
      if (!name) {
        warnings.push(`"${specName}": an attribute facet has no name and was skipped.`);
        return null;
      }
      return { ...base, type: "attribute", name, value: parseValue(childOf(element, "value")) };
    }
    case "property": {
      const propertySet = parseValue(childOf(element, "propertySet"));
      const baseName = parseValue(childOf(element, "baseName")) ?? parseValue(childOf(element, "name"));
      if (!baseName) {
        warnings.push(`"${specName}": a property facet has no baseName and was skipped.`);
        return null;
      }
      const dataType = (element.getAttribute("dataType") ?? element.getAttribute("datatype") ?? element.getAttribute("measure") ?? undefined)?.toUpperCase();
      return { ...base, type: "property", propertySet: propertySet ?? ANY, baseName, value: parseValue(childOf(element, "value")), dataType, uri: element.getAttribute("uri") ?? undefined };
    }
    case "classification":
      return { ...base, type: "classification", system: parseValue(childOf(element, "system")), value: parseValue(childOf(element, "value")), uri: element.getAttribute("uri") ?? undefined };
    case "material":
      return { ...base, type: "material", value: parseValue(childOf(element, "value")), uri: element.getAttribute("uri") ?? undefined };
    case "partOf": {
      const entity = childOf(element, "entity");
      const name = entity ? parseValue(childOf(entity, "name")) : undefined;
      if (!entity || !name) {
        warnings.push(`"${specName}": a partOf facet has no entity and was skipped.`);
        return null;
      }
      return { ...base, type: "partOf", relation: element.getAttribute("relation")?.toUpperCase() ?? undefined, entity: { name, predefinedType: parseValue(childOf(entity, "predefinedType")) } };
    }
    default:
      warnings.push(`"${specName}": unknown facet <${local(element)}> was skipped.`);
      return null;
  }
}

export function parseIds(xml: string, fileName: string): IdsDocument {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = dom.getElementsByTagName("parsererror")[0];
  if (parserError) throw new Error(`${fileName} is not valid XML: ${parserError.textContent?.split("\n")[0] ?? "parse error"}`);
  const root = dom.documentElement;
  if (!root || local(root) !== "ids") throw new Error(`${fileName} is not an IDS file (root element is <${root ? local(root) : "?"}>).`);

  const warnings: string[] = [];
  const info = childOf(root, "info");
  const specsElement = childOf(root, "specifications");
  const specifications: IdsSpecification[] = [];

  childrenOf(specsElement ?? root, "specification").forEach((element, position) => {
    const name = element.getAttribute("name") ?? `Specification ${position + 1}`;
    const applicabilityElement = childOf(element, "applicability");
    const requirementsElement = childOf(element, "requirements");
    const applicability = applicabilityElement ? childrenOf(applicabilityElement).map((facet) => parseFacet(facet, warnings, name)).filter((facet): facet is IdsFacet => facet !== null) : [];
    const requirements = requirementsElement ? childrenOf(requirementsElement).map((facet) => parseFacet(facet, warnings, name)).filter((facet): facet is IdsFacet => facet !== null) : [];

    // Specification-level cardinality lives on <applicability> in IDS 1.0 and on <specification> in 0.9.
    const min = applicabilityElement?.getAttribute("minOccurs") ?? element.getAttribute("minOccurs");
    const max = applicabilityElement?.getAttribute("maxOccurs") ?? element.getAttribute("maxOccurs");
    const occurrence: IdsSpecification["occurrence"] = max === "0" ? "prohibited" : min === "0" ? "optional" : min === null && max === null ? "optional" : "required";

    specifications.push({
      id: `${fileName}#${position}`,
      name,
      description: element.getAttribute("description") ?? undefined,
      instructions: element.getAttribute("instructions") ?? undefined,
      identifier: element.getAttribute("identifier") ?? undefined,
      ifcVersions: (element.getAttribute("ifcVersion") ?? "").split(/\s+/).filter(Boolean).map((version) => version.toUpperCase()),
      occurrence,
      applicability,
      requirements,
    });
  });

  if (specifications.length === 0) warnings.push("The file contains no specifications.");

  return {
    fileName,
    title: textOf(info ? childOf(info, "title") : undefined) ?? fileName,
    description: textOf(info ? childOf(info, "description") : undefined),
    author: textOf(info ? childOf(info, "author") : undefined),
    version: textOf(info ? childOf(info, "version") : undefined),
    date: textOf(info ? childOf(info, "date") : undefined),
    purpose: textOf(info ? childOf(info, "purpose") : undefined),
    milestone: textOf(info ? childOf(info, "milestone") : undefined),
    specifications,
    warnings,
  };
}
