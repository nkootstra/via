import { defineRule } from "@oxlint/plugins";

import {
	isInsideBroadEffectHandler,
	isReasonTagMember,
	tagMember,
	tagMemberFromComparison,
} from "../shared/tagged-values.ts";

export const noManualEffectErrorTagRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Use Effect tagged error handlers instead of manually branching on `_tag` in a catch handler.",
		},
		messages: {
			tag: "Use Effect.catchTag or Effect.catchTags instead of manually discriminating a tagged error in a broad Effect catch handler.",
			reason:
				"Use Effect.catchReason or Effect.catchReasons instead of manually discriminating a tagged `reason` in a broad Effect catch handler.",
		},
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				const member = tagMemberFromComparison(node);
				if (
					member === undefined ||
					!isInsideBroadEffectHandler(node)
				) {
					return;
				}
				context.report({
					node,
					messageId: isReasonTagMember(member) ? "reason" : "tag",
				});
			},
			SwitchStatement(node) {
				const member = tagMember(node.discriminant);
				if (
					member === undefined ||
					!isInsideBroadEffectHandler(node)
				) {
					return;
				}
				context.report({
					node,
					messageId: isReasonTagMember(member) ? "reason" : "tag",
				});
			},
		};
	},
});
