// A release sets the version in package.json before it builds the binary.
export { version } from "../package.json" with { type: "json" };
