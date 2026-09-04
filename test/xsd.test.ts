import { describe, expect, test } from "bun:test";
import { parseDocument, type XmlNode } from "../shared/xml.ts";
import {
  builtinError,
  compileXsdSet,
  validateXmlDocument,
  XsdUnsupported,
  xsdPatternToJs,
  type XsdBundle,
} from "../shared/xsd.ts";

const XSD = 'xmlns:xs="http://www.w3.org/2001/XMLSchema"';
const TNS = 'xmlns:tns="urn:test" targetNamespace="urn:test" elementFormDefault="qualified"';

function schema(body: string): XmlNode {
  return parseDocument(`<xs:schema ${XSD} ${TNS}>${body}</xs:schema>`);
}

function bundleOf(body: string): XsdBundle {
  return compileXsdSet([schema(body)]);
}

/** Validates an instance document against a compiled bundle. */
function check(bundle: XsdBundle, xml: string) {
  return validateXmlDocument(xml, bundle);
}

const PET = `
  <xs:element name="Pet" type="tns:PetType"/>
  <xs:complexType name="PetType">
    <xs:sequence>
      <xs:element name="id" type="xs:int"/>
      <xs:element name="name" type="tns:NameType"/>
      <xs:element name="tag" type="xs:string" minOccurs="0"/>
      <xs:element name="photo" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
    <xs:attribute name="status" type="tns:StatusType" use="required"/>
    <xs:attribute name="note" type="xs:string"/>
  </xs:complexType>
  <xs:simpleType name="NameType">
    <xs:restriction base="xs:string">
      <xs:minLength value="2"/>
      <xs:maxLength value="20"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="StatusType">
    <xs:restriction base="xs:string">
      <xs:enumeration value="available"/>
      <xs:enumeration value="sold"/>
    </xs:restriction>
  </xs:simpleType>`;

const ok = `<tns:Pet xmlns:tns="urn:test" status="available"><tns:id>1</tns:id><tns:name>Rex</tns:name></tns:Pet>`;

describe("the XSD subset — compilation", () => {
  test("global elements and named types reach the bundle", () => {
    const bundle = bundleOf(PET);
    expect(Object.keys(bundle.elements)).toEqual(["{urn:test}Pet"]);
    expect(bundle.elements["{urn:test}Pet"]!.typeRef).toBe("{urn:test}PetType");
    expect(bundle.types["{urn:test}PetType"]!.kind).toBe("complex");
    expect(bundle.types["{urn:test}NameType"]).toMatchObject({
      kind: "simple",
      builtin: "string",
      facets: { minLength: 2, maxLength: 20 },
    });
  });

  test("facets flatten along the derivation chain, so the runtime walks no base chain", () => {
    const bundle = bundleOf(`
      <xs:element name="V" type="tns:Narrow"/>
      <xs:simpleType name="Wide">
        <xs:restriction base="xs:string"><xs:maxLength value="10"/></xs:restriction>
      </xs:simpleType>
      <xs:simpleType name="Narrow">
        <xs:restriction base="tns:Wide"><xs:minLength value="3"/></xs:restriction>
      </xs:simpleType>`);
    expect(bundle.types["{urn:test}Narrow"]).toMatchObject({
      builtin: "string",
      facets: { minLength: 3, maxLength: 10 },
    });
  });

  test("unsupported constructs are refused at import, naming the construct", () => {
    for (const body of [
      `<xs:element name="A" type="xs:string"><xs:key name="k"><xs:selector xpath="."/></xs:key></xs:element>`,
      `<xs:element name="A" type="xs:string" substitutionGroup="tns:B"/>`,
      `<xs:complexType name="T" abstract="true"><xs:sequence/></xs:complexType>`,
      `<xs:notation name="n" public="p"/>`,
    ]) {
      expect(() => bundleOf(body)).toThrow(XsdUnsupported);
    }
  });

  test("XSD patterns are translated, not passed through", () => {
    // XSD patterns are implicitly anchored, and ^ and $ are literals inside them.
    expect(xsdPatternToJs("[0-9]{3}", "t")).toBe("^(?:[0-9]{3})$");
    expect(xsdPatternToJs("a\\ib", "t")).toBe("^(?:a[A-Za-z_:]b)$");
    expect(xsdPatternToJs("a$b", "t")).toBe("^(?:a\\$b)$");
    const bundle = bundleOf(`
      <xs:element name="Vin" type="tns:VinType"/>
      <xs:simpleType name="VinType">
        <xs:restriction base="xs:string"><xs:pattern value="[A-Z0-9]{5}"/></xs:restriction>
      </xs:simpleType>`);
    expect(check(bundle, `<tns:Vin xmlns:tns="urn:test">ABC12</tns:Vin>`).ok).toBe(true);
    // Unanchored in JS this would match; anchored, as XSD means it, it does not.
    expect(check(bundle, `<tns:Vin xmlns:tns="urn:test">xxABC12xx</tns:Vin>`).ok).toBe(false);
  });
});

describe("the XSD subset — validation", () => {
  const bundle = bundleOf(PET);

  test("a conforming document passes", () => {
    expect(check(bundle, ok).ok).toBe(true);
  });

  test("an undeclared root element is refused", () => {
    const result = check(bundle, `<tns:Cat xmlns:tns="urn:test"/>`);
    expect(result.issues[0]!.message).toContain("is not a global element");
  });

  test("element order and cardinality", () => {
    const swapped = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:name>Rex</tns:name><tns:id>1</tns:id></tns:Pet>`;
    expect(check(bundle, swapped).ok).toBe(false);
    const missing = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:id>1</tns:id></tns:Pet>`;
    expect(check(bundle, missing).issues[0]!.message).toContain("<name>");
    const repeated = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:id>1</tns:id><tns:name>Rex</tns:name>` +
      `<tns:photo>a</tns:photo><tns:photo>b</tns:photo></tns:Pet>`;
    expect(check(bundle, repeated).ok).toBe(true);
    const tooMany = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:id>1</tns:id><tns:name>Rex</tns:name>` +
      `<tns:tag>a</tns:tag><tns:tag>b</tns:tag></tns:Pet>`;
    expect(check(bundle, tooMany).ok).toBe(false);
  });

  test("simple type facets, reported against the failing element", () => {
    const short = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:id>1</tns:id><tns:name>R</tns:name></tns:Pet>`;
    expect(check(bundle, short).issues[0]).toMatchObject({ rule: "minLength", path: "/Pet/name" });
    const badInt = `<tns:Pet xmlns:tns="urn:test" status="sold"><tns:id>x</tns:id><tns:name>Rex</tns:name></tns:Pet>`;
    expect(check(bundle, badInt).issues[0]).toMatchObject({ rule: "type", path: "/Pet/id" });
  });

  test("attributes: required, undeclared, and enumerated", () => {
    const noStatus = `<tns:Pet xmlns:tns="urn:test"><tns:id>1</tns:id><tns:name>Rex</tns:name></tns:Pet>`;
    expect(check(bundle, noStatus).issues[0]!.message).toContain("required attribute");
    const badStatus = ok.replace('status="available"', 'status="gone"');
    expect(check(bundle, badStatus).issues[0]).toMatchObject({ rule: "enumeration" });
    const extra = ok.replace('status="available"', 'status="available" colour="red"');
    expect(check(bundle, extra).issues[0]!.message).toContain('"colour" is not declared');
  });

  test("choice picks a branch by name, and rejects a member of no branch", () => {
    const b = bundleOf(`
      <xs:element name="Payment" type="tns:PaymentType"/>
      <xs:complexType name="PaymentType">
        <xs:choice>
          <xs:element name="card" type="xs:string"/>
          <xs:element name="iban" type="xs:string"/>
        </xs:choice>
      </xs:complexType>`);
    expect(check(b, `<tns:Payment xmlns:tns="urn:test"><tns:iban>X</tns:iban></tns:Payment>`).ok).toBe(true);
    expect(check(b, `<tns:Payment xmlns:tns="urn:test"><tns:cash>X</tns:cash></tns:Payment>`).ok).toBe(false);
    // A choice is one branch, once.
    expect(
      check(b, `<tns:Payment xmlns:tns="urn:test"><tns:card>A</tns:card><tns:iban>B</tns:iban></tns:Payment>`).ok,
    ).toBe(false);
  });

  test("all is unordered", () => {
    const b = bundleOf(`
      <xs:element name="Order" type="tns:OrderType"/>
      <xs:complexType name="OrderType">
        <xs:all>
          <xs:element name="a" type="xs:string"/>
          <xs:element name="b" type="xs:string"/>
        </xs:all>
      </xs:complexType>`);
    expect(check(b, `<tns:Order xmlns:tns="urn:test"><tns:b>1</tns:b><tns:a>2</tns:a></tns:Order>`).ok).toBe(true);
    expect(check(b, `<tns:Order xmlns:tns="urn:test"><tns:b>1</tns:b></tns:Order>`).ok).toBe(false);
  });

  test("complexContent extension is the base's model then the derived one", () => {
    const b = bundleOf(`
      <xs:element name="Dog" type="tns:DogType"/>
      <xs:complexType name="AnimalType">
        <xs:sequence><xs:element name="id" type="xs:int"/></xs:sequence>
        <xs:attribute name="kind" type="xs:string"/>
      </xs:complexType>
      <xs:complexType name="DogType">
        <xs:complexContent>
          <xs:extension base="tns:AnimalType">
            <xs:sequence><xs:element name="breed" type="xs:string"/></xs:sequence>
          </xs:extension>
        </xs:complexContent>
      </xs:complexType>`);
    expect(
      check(b, `<tns:Dog xmlns:tns="urn:test" kind="pet"><tns:id>1</tns:id><tns:breed>lab</tns:breed></tns:Dog>`).ok,
    ).toBe(true);
    expect(check(b, `<tns:Dog xmlns:tns="urn:test"><tns:breed>lab</tns:breed></tns:Dog>`).ok).toBe(false);
  });

  test("simpleContent extension is text plus attributes", () => {
    const b = bundleOf(`
      <xs:element name="Price" type="tns:PriceType"/>
      <xs:complexType name="PriceType">
        <xs:simpleContent>
          <xs:extension base="xs:decimal">
            <xs:attribute name="currency" type="xs:string" use="required"/>
          </xs:extension>
        </xs:simpleContent>
      </xs:complexType>`);
    expect(check(b, `<tns:Price xmlns:tns="urn:test" currency="CZK">10.50</tns:Price>`).ok).toBe(true);
    expect(check(b, `<tns:Price xmlns:tns="urn:test" currency="CZK">ten</tns:Price>`).ok).toBe(false);
    expect(check(b, `<tns:Price xmlns:tns="urn:test">10</tns:Price>`).ok).toBe(false);
  });

  test("nillable, and xsi:nil on an element that is not", () => {
    const b = bundleOf(`
      <xs:element name="Box" type="tns:BoxType"/>
      <xs:complexType name="BoxType">
        <xs:sequence>
          <xs:element name="maybe" type="xs:string" nillable="true"/>
          <xs:element name="always" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>`);
    const xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    expect(
      check(b, `<tns:Box xmlns:tns="urn:test" ${xsi}><tns:maybe xsi:nil="true"/><tns:always>x</tns:always></tns:Box>`).ok,
    ).toBe(true);
    expect(
      check(b, `<tns:Box xmlns:tns="urn:test" ${xsi}><tns:maybe>a</tns:maybe><tns:always xsi:nil="true"/></tns:Box>`)
        .issues[0]!.rule,
    ).toBe("nillable");
  });

  test("unqualified local elements when elementFormDefault is absent", () => {
    const unqualified = parseDocument(
      `<xs:schema ${XSD} xmlns:tns="urn:test" targetNamespace="urn:test">
         <xs:element name="Req" type="tns:ReqType"/>
         <xs:complexType name="ReqType">
           <xs:sequence><xs:element name="id" type="xs:int"/></xs:sequence>
         </xs:complexType>
       </xs:schema>`,
    );
    const b = compileXsdSet([unqualified]);
    expect(check(b, `<tns:Req xmlns:tns="urn:test"><id>1</id></tns:Req>`).ok).toBe(true);
    expect(check(b, `<tns:Req xmlns:tns="urn:test"><tns:id>1</tns:id></tns:Req>`).ok).toBe(false);
  });

  test("groups are expanded, and a cycle is refused rather than followed", () => {
    const b = bundleOf(`
      <xs:group name="Ids">
        <xs:sequence><xs:element name="id" type="xs:int"/></xs:sequence>
      </xs:group>
      <xs:element name="Thing" type="tns:ThingType"/>
      <xs:complexType name="ThingType">
        <xs:sequence>
          <xs:group ref="tns:Ids"/>
          <xs:element name="name" type="xs:string"/>
        </xs:sequence>
      </xs:complexType>`);
    expect(check(b, `<tns:Thing xmlns:tns="urn:test"><tns:id>1</tns:id><tns:name>x</tns:name></tns:Thing>`).ok).toBe(
      true,
    );
    expect(() =>
      bundleOf(`
        <xs:group name="Loop"><xs:sequence><xs:group ref="tns:Loop"/></xs:sequence></xs:group>
        <xs:element name="T" type="tns:TT"/>
        <xs:complexType name="TT"><xs:sequence><xs:group ref="tns:Loop"/></xs:sequence></xs:complexType>`),
    ).toThrow(XsdUnsupported);
  });

  test("a malformed or hostile document is refused by the reader, not the schema", () => {
    const evil = `<!DOCTYPE x [<!ENTITY e "boom">]><tns:Pet xmlns:tns="urn:test"/>`;
    const result = check(bundle, evil);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.rule).toBe("xml");
  });

  test("built-in lexical forms", () => {
    expect(builtinError("int", "42")).toBeNull();
    expect(builtinError("int", "2147483648")).toContain("above the range");
    expect(builtinError("boolean", "1")).toBeNull();
    expect(builtinError("boolean", "yes")).not.toBeNull();
    expect(builtinError("decimal", "1.5")).toBeNull();
    expect(builtinError("decimal", "1e5")).not.toBeNull();
    expect(builtinError("double", "1e5")).toBeNull();
    expect(builtinError("dateTime", "2026-09-01T10:00:00Z")).toBeNull();
    expect(builtinError("date", "2026-09-01")).toBeNull();
    expect(builtinError("duration", "P1Y2M")).toBeNull();
    expect(builtinError("hexBinary", "abcd")).toBeNull();
    expect(builtinError("hexBinary", "abc")).not.toBeNull();
    expect(builtinError("unsignedByte", "-1")).toContain("below the range");
  });

  test("a union accepts a member and reports when nothing matches", () => {
    const b = bundleOf(`
      <xs:element name="Ref" type="tns:RefType"/>
      <xs:simpleType name="RefType">
        <xs:union memberTypes="xs:int xs:date"/>
      </xs:simpleType>`);
    expect(check(b, `<tns:Ref xmlns:tns="urn:test">7</tns:Ref>`).ok).toBe(true);
    expect(check(b, `<tns:Ref xmlns:tns="urn:test">2026-09-01</tns:Ref>`).ok).toBe(true);
    expect(check(b, `<tns:Ref xmlns:tns="urn:test">nope</tns:Ref>`).issues[0]!.rule).toBe("union");
  });

  test("a list validates every item", () => {
    const b = bundleOf(`
      <xs:element name="Ids" type="tns:IdList"/>
      <xs:simpleType name="IdList"><xs:list itemType="xs:int"/></xs:simpleType>`);
    expect(check(b, `<tns:Ids xmlns:tns="urn:test">1 2 3</tns:Ids>`).ok).toBe(true);
    expect(check(b, `<tns:Ids xmlns:tns="urn:test">1 x 3</tns:Ids>`).ok).toBe(false);
  });
});
