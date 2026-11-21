// Data model for buildingSMART IDS 1.0 (Information Delivery Specification).

/** A value constraint: either one literal or an XSD restriction. */
export type IdsValue =
  | { kind: "simple"; value: string }
  | {
      kind: "restriction";
      base?: string;
      enumeration?: string[];
      pattern?: string[];
      minInclusive?: number;
      maxInclusive?: number;
      minExclusive?: number;
      maxExclusive?: number;
      length?: number;
      minLength?: number;
      maxLength?: number;
    };

export type IdsCardinality = "required" | "optional" | "prohibited";

interface FacetBase {
  /** Only meaningful in requirements; applicability facets are always "required". */
  cardinality: IdsCardinality;
  instructions?: string;
}

export interface EntityFacet extends FacetBase {
  type: "entity";
  name: IdsValue;
  predefinedType?: IdsValue;
}

export interface AttributeFacet extends FacetBase {
  type: "attribute";
  name: IdsValue;
  value?: IdsValue;
}

export interface PropertyFacet extends FacetBase {
  type: "property";
  propertySet: IdsValue;
  baseName: IdsValue;
  value?: IdsValue;
  dataType?: string;
  uri?: string;
}

export interface ClassificationFacet extends FacetBase {
  type: "classification";
  system?: IdsValue;
  value?: IdsValue;
  uri?: string;
}

export interface MaterialFacet extends FacetBase {
  type: "material";
  value?: IdsValue;
  uri?: string;
}

export interface PartOfFacet extends FacetBase {
  type: "partOf";
  /** e.g. IFCRELAGGREGATES; undefined accepts any part-of relation. */
  relation?: string;
  entity: { name: IdsValue; predefinedType?: IdsValue };
}

export type IdsFacet = EntityFacet | AttributeFacet | PropertyFacet | ClassificationFacet | MaterialFacet | PartOfFacet;

export interface IdsSpecification {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  identifier?: string;
  ifcVersions: string[];
  /** required: at least one applicable entity must exist; prohibited: none may exist. */
  occurrence: "required" | "optional" | "prohibited";
  applicability: IdsFacet[];
  requirements: IdsFacet[];
}

export interface IdsDocument {
  fileName: string;
  title: string;
  description?: string;
  author?: string;
  version?: string;
  date?: string;
  purpose?: string;
  milestone?: string;
  specifications: IdsSpecification[];
  /** Problems found while reading the file (unknown facets and the like). */
  warnings: string[];
}
