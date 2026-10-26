export * from "./generated/api";
// The generated types live in ./generated/types and one of them
// (`CreateRoomBody`) collides with the Zod schema value of the same name in
// ./generated/api. Re-export the non-colliding types only; the interface is
// still available from @workspace/api-client-react.
export type { ErrorResponse, HealthStatus, Room } from "./generated/types";
