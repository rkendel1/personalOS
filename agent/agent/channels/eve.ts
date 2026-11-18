import { jwtHmac, placeholderAuth } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    jwtHmac({
      algorithm: "HS256",
      audiences: [process.env.AGENT_JWT_AUDIENCE ?? "appport-agent"],
      issuer: process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator",
      secret: process.env.AGENT_JWT_SECRET ?? "",
    }),
    placeholderAuth(),
  ],
});
