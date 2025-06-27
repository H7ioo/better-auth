import { z } from "zod";
import { APIError, sessionMiddleware } from "better-auth/api";
import { type BetterAuthPlugin, logger } from "better-auth";
import { createAuthEndpoint } from "better-auth/plugins";
import { setSessionCookie } from "better-auth/cookies";
import * as saml from "samlify";
import type { Session, User } from "../../../better-auth/src";
import type { BindingContext } from "samlify/types/src/entity";
import type { FlowResult } from "samlify/types/src/flow";
import { type SAMLSSOOptions, type SAMLConfig } from "./types";

saml.setSchemaValidator({
	validate: (response) => {
		/* implment your own or always returns a resolved promise to skip */
		return Promise.resolve("skipped");
	},
});

const SAMLConfigSchema = z.object({
	entryPoint: z.string(),
	providerId: z.string(),
	issuer: z.string(),
	cert: z.string(),
	callbackUrl: z.string(),
	audience: z.string().optional(),
	domain: z.string().optional(),
	mapping: z
		.object({
			id: z
				.string({
					description:
						"The field in the user info response that contains the id. Defaults to 'sub'",
				})
				.optional(),
			email: z
				.string({
					description:
						"The field in the user info response that contains the email. Defaults to 'email'",
				})
				.optional(),
			firstName: z
				.string({
					description:
						"The field in the user info response that contains the first name. Defaults to 'givenName'",
				})
				.optional(),
			lastName: z
				.string({
					description:
						"The field in the user info response that contains the last name. Defaults to 'surname'",
				})
				.optional(),
			extraFields: z.record(z.string()).optional(),
		})
		.optional(),
	idpMetadata: z
		.object({
			metadata: z.string(),
			privateKey: z.string().optional(),
			privateKeyPass: z.string().optional(),
			isAssertionEncrypted: z.boolean().optional(),
			encPrivateKey: z.string().optional(),
			encPrivateKeyPass: z.string().optional(),
		})
		.optional(),
	spMetadata: z.object({
		metadata: z.string(),
		binding: z.string().optional(),

		privateKey: z.string().optional(),
		privateKeyPass: z.string().optional(),
		isAssertionEncrypted: z.boolean().optional(),
		encPrivateKey: z.string().optional(),
		encPrivateKeyPass: z.string().optional(),
	}),
	wantAssertionsSigned: z.boolean().optional(),
	signatureAlgorithm: z.string().optional(),
	digestAlgorithm: z.string().optional(),
	identifierFormat: z.string().optional(),
	privateKey: z.string().optional(),
	decryptionPvk: z.string().optional(),
	additionalParams: z.record(z.string()).optional(),
});

export const ssoSAML = (options?: SAMLSSOOptions) => {
	return {
		id: "saml",
		endpoints: {
			spMetadata: createAuthEndpoint(
				"/sso/saml2/sp/metadata",
				{
					method: "GET",
					query: z.object({
						providerId: z.string(),
						format: z.enum(["xml", "json"]).default("xml"),
					}),
					metadata: {
						openapi: {
							summary: "Get Service Provider metadata",
							description: "Returns the SAML metadata for the Service Provider",
							responses: {
								"200": {
									description: "SAML metadata in XML format",
								},
							},
						},
					},
				},
				async (ctx) => {
					const provider = await ctx.context.adapter.findOne<{
						samlConfig: string;
					}>({
						model: "ssoProvider",
						where: [
							{
								field: "providerId",
								value: ctx.query.providerId,
							},
						],
					});
					if (!provider) {
						throw new APIError("NOT_FOUND", {
							message: "No provider found for the given providerId",
						});
					}

					const parsedSamlConfig = JSON.parse(provider.samlConfig);
					const sp = saml.ServiceProvider({
						metadata: parsedSamlConfig.spMetadata.metadata,
					});
					return new Response(sp.getMetadata(), {
						headers: {
							"Content-Type": "application/xml",
						},
					});
				},
			),
			createSAMLProvider: createAuthEndpoint(
				"/sso/saml2/register",
				{
					method: "POST",
					body: SAMLConfigSchema,
					use: [sessionMiddleware],
					metadata: {
						openapi: {
							summary: "Register a SAML provider",
							description: "This endpoint is used to register a SAML provider.",
							responses: {
								"200": {
									description: "The created provider",
								},
							},
						},
					},
				},
				async (ctx) => {
					const body = ctx.body;
					const provider = await ctx.context.adapter.create({
						model: "ssoProvider",
						data: {
							issuer: body.issuer,
							samlConfig: JSON.stringify(body),
							providerId: body.providerId,
						},
					});
					return ctx.json({
						...provider,
						samlConfig: JSON.parse(provider.samlConfig) as SAMLConfig,
					});
				},
			),

			signInSSOSAML: createAuthEndpoint(
				"/sso/saml2/sign-in",
				{
					method: "POST",
					body: z.object({
						providerId: z.string(),
						callbackURL: z.string(),
					}),
					metadata: {
						openapi: {
							summary: "Sign in with SAML provider",
							description:
								"This endpoint is used to sign in with a SAML provider.",
							responses: {
								"200": {
									description: "The SAML login URL",
								},
							},
						},
					},
				},
				async (ctx) => {
					const { providerId, callbackURL } = ctx.body;
					const provider = await ctx.context.adapter.findOne<{
						samlConfig: string;
					}>({
						model: "ssoProvider",
						where: [
							{
								field: "providerId",
								value: providerId,
							},
						],
					});

					if (!provider) {
						throw new APIError("NOT_FOUND", {
							message: "No provider found for the given providerId",
						});
					}

					const parsedSamlConfig = JSON.parse(provider.samlConfig);
					const sp = saml.ServiceProvider({
						metadata: parsedSamlConfig.spMetadata.metadata,
						allowCreate: true,
					});
					const idp = saml.IdentityProvider({
						metadata: parsedSamlConfig.idpMetadata.metadata,
					});
					const loginRequest = sp.createLoginRequest(
						idp,
						"redirect",
					) as BindingContext & { entityEndpoint: string; type: string };
					if (!loginRequest) {
						throw new APIError("BAD_REQUEST", {
							message: "Invalid SAML request",
						});
					}
					return ctx.json({
						url: loginRequest.context,
						redirect: true,
					});
				},
			),
			callbackSSOSAML: createAuthEndpoint(
				"/sso/saml2/callback/:providerId",
				{
					method: "POST",
					body: z.object({
						SAMLResponse: z.string(),
						RelayState: z.string().optional(),
					}),
					metadata: {
						isAction: false,
						openapi: {
							summary: "Callback URL for SAML provider",
							description:
								"This endpoint is used as the callback URL for SAML providers.",
							responses: {
								"302": {
									description: "Redirects to the callback URL",
								},
								"400": {
									description: "Invalid SAML response",
								},
								"401": {
									description: "Unauthorized - SAML authentication failed",
								},
							},
						},
					},
				},
				async (ctx) => {
					const { SAMLResponse, RelayState } = ctx.body;
					const { providerId } = ctx.params;
					const provider = await ctx.context.adapter.findOne<{
						samlConfig: string;
					}>({
						model: "ssoProvider",
						where: [{ field: "providerId", value: providerId }],
					});

					if (!provider) {
						throw new APIError("NOT_FOUND", {
							message: "No provider found for the given providerId",
						});
					}

					const parsedSamlConfig = JSON.parse(provider.samlConfig);
					const idp = saml.IdentityProvider({
						metadata: parsedSamlConfig.idpMetadata.metadata,
					});
					const sp = saml.ServiceProvider({
						metadata: parsedSamlConfig.spMetadata.metadata,
					});
					let parsedResponse: FlowResult;
					try {
						parsedResponse = await sp.parseLoginResponse(idp, "post", {
							body: { SAMLResponse, RelayState },
						});

						if (!parsedResponse) {
							throw new Error("Empty SAML response");
						}
					} catch (error) {
						logger.error("SAML response validation failed", error);
						throw new APIError("BAD_REQUEST", {
							message: "Invalid SAML response",
							details: error instanceof Error ? error.message : String(error),
						});
					}
					const { extract } = parsedResponse;
					const attributes = parsedResponse.extract.attributes;
					const mapping = parsedSamlConfig?.mapping ?? {};
					const userInfo = {
						...Object.fromEntries(
							Object.entries(mapping.extraFields || {}).map(([key, value]) => [
								key,
								extract.attributes[value as string],
							]),
						),
						id: attributes[mapping.id || "nameID"],
						email: attributes[mapping.email || "nameID" || "email"],
						name:
							[
								attributes[mapping.firstName || "givenName"],
								attributes[mapping.lastName || "surname"],
							]
								.filter(Boolean)
								.join(" ") || parsedResponse.extract.attributes?.displayName,
						attributes: parsedResponse.extract.attributes,
					};

					let user: User;
					if (options?.provisionUser) {
						user = await options.provisionUser(userInfo);
					} else {
						const existingUser = await ctx.context.adapter.findOne<User>({
							model: "user",
							where: [
								{
									field: "email",
									value: userInfo.email,
								},
							],
						});

						if (existingUser) {
							user = existingUser;
						} else {
							user = await ctx.context.adapter.create({
								model: "user",
								data: {
									email: userInfo.email,
									name: userInfo.name,
									emailVerified: true,
								},
							});
						}
					}

					if (options?.organizationProvisioning?.enabled) {
						const organizationId =
							await options.organizationProvisioning.getOrganizationId(
								userInfo,
							);
						if (organizationId) {
							const existingMembership = await ctx.context.adapter.findOne({
								model: "organizationMember",
								where: [
									{ field: "userId", value: user.id },
									{ field: "organizationId", value: organizationId },
								],
							});

							if (!existingMembership) {
								await ctx.context.adapter.create({
									model: "organizationMember",
									data: {
										userId: user.id,
										organizationId: organizationId,
										role:
											options.organizationProvisioning.defaultRole || "member",
									},
								});
							}
						}
					}

					let session: Session =
						await ctx.context.internalAdapter.createSession(
							user.id,
							ctx.request as any,
						);
					await setSessionCookie(ctx, { session, user });
					return ctx.json({
						redirect: true,
						url: RelayState || `${parsedSamlConfig.issuer}/dashboard`,
					});
				},
			),
		},
		schema: {
			ssoProvider: {
				fields: {
					issuer: {
						type: "string",
						required: true,
					},
					samlConfig: {
						type: "string",
						required: true,
					},
					providerId: {
						type: "string",
						required: true,
						unique: true,
					},
				},
			},
			organizationMember: {
				fields: {
					userId: {
						type: "string",
						required: true,
					},
					organizationId: {
						type: "string",
						required: true,
					},
					role: {
						type: "string",
						required: true,
					},
				},
			},
		},
	} satisfies BetterAuthPlugin;
};
