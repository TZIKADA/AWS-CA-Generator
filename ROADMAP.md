# POC Plan: AI Certificate Management on AWS

The key to a good POC is a **narrow vertical slice**: prove the riskiest, most valuable idea end to end rather than building every feature shallowly. Here, that is "AI-driven policy enforcement over certificate lifecycle, with access control."

## **<!-- gdoc_comment_begin: c1 -->**1\. Define scope and success criteria (Week 1\)

- **Hypothesis:** AI can safely automate certificate and secret management tasks that are normally manual.
- **In scope:** certificate issuance and renewal, role-based access control, one policy enforced by AI, an audit trail.
- **Out of scope (for now):** multi-tenant billing, full UI, every integration, HA and DR.
- **Success metrics:** e.g. certificate issued in under 1 minute, 100% of actions logged, AI correctly translates 9 of 10 test policies, zero unauthorized access in tests.<!-- gdoc_comment_end: c1 -->

## 2\. Choose the architecture and AWS services \- **עמית**

| Capability                           | Suggested service                                          |
| :----------------------------------- | :--------------------------------------------------------- |
| Certificate issuance                 | AWS Private CA \+ ACM                                      |
| Keyrings / encryption keys           | AWS KMS                                                    |
| Password generation / secret storage | Secrets Manager (+ Lambda generator)                       |
| Access control                       | IAM, Cognito, Amazon Verified Permissions (Cedar policies) |
| API layer                            | API Gateway \+ Lambda                                      |
| Data                                 | DynamoDB (inventory, policies), S3 (reports)               |
| Automation                           | EventBridge \+ Step Functions                              |
| Audit                                | CloudTrail, CloudWatch, AWS Config                         |
| AI features                          | Amazon Bedrock (with Guardrails, optionally Agents)        |

&nbsp;

Use the two AWS reference architectures as guides for isolation, encryption, and compliance patterns, and reuse their ideas for separating sensitive data and logging:

&nbsp;

- [Data Escrow Environment](https://docs.aws.amazon.com/reference-architecture-diagrams/latest/data-escrow-environment/data-escrow-environment.html)
- [Content Moderation and Compliance](https://docs.aws.amazon.com/reference-architecture-diagrams/latest/content-moderation-compliance/content-moderation-compliance.html)

## 3\. Build the foundation (Week 1-2) \- **דולב**

- Create a dedicated sandbox AWS account (never use production).
- Define everything as code with CDK or Terraform.
- Set up a VPC, KMS customer-managed keys, CloudTrail, and a least-privilege IAM baseline.

## 4\. Build the core certificate service (Week 2\) \- **איתי**

- Stand up a Private CA.
- Create API endpoints: `request-cert`, `renew-cert`, `revoke-cert`, `list-certs`.
- Store certificate metadata (owner, expiry, status) in DynamoDB.
- Add an EventBridge rule that detects upcoming expirations and triggers automatic renewal via Step Functions.

## 5\. Add access control (Week 2-3) \- **דן**

- Authenticate users with Cognito.
- Define roles (admin, team owner, auditor) and write Cedar policies in Verified Permissions.
- Enforce authorization in every API call, and test that unauthorized requests are denied.

## <!-- gdoc_comment_begin: c2 -->6\. Add keyring and password features (Week 3\)<!-- gdoc_comment_end: c2 -->

- Lambda generates passwords following a configurable policy (length, complexity, rotation period).
- Store them in Secrets Manager with automatic rotation.
- Keep this minimal: one secret type is enough for the POC.

## <!-- gdoc_comment_begin: c3 -->7\. Add the AI layer (Week 3-4)<!-- gdoc_comment_end: c3 -->

This is the differentiator, so pick two or three focused use cases:

&nbsp;

- **Natural language to policy:** an admin types "All production certs must expire within 90 days and use RSA 3072+," and Bedrock generates a Cedar or config rule that is shown for human approval before activation.
- **Anomaly detection:** Bedrock analyzes CloudTrail logs and flags unusual patterns, like a burst of certificate requests at 3 AM.
- **Compliance assistant:** answers questions like "Which certificates violate our policy?" using your inventory.

&nbsp;

**Important guardrails:** use Bedrock Guardrails, require human approval for any destructive or permission-changing action, validate all AI output against a schema, and never give the model direct access to private keys or secret values.

## 8\. Build one integration (Week 4\)

Show automated enrollment with something simple: a webhook or API call from a CI/CD pipeline or a sample EC2/ECS app that requests and installs a certificate automatically.

## 9\. Add a minimal interface (Week 4-5)

A simple dashboard (S3 \+ CloudFront or Amplify) showing the certificate inventory, policy status, and audit log is enough. A CLI or Postman collection is fine too.

## <!-- gdoc_comment_begin: c4 -->10\. Test and validate (Week 5\)

- Functional tests for each flow.
- Security tests: attempt privilege escalation, prompt injection against the AI features, and access to another team's resources.
- Measure against your success metrics from step 1\.<!-- gdoc_comment_end: c4 -->

## 11\. Demo, document, and decide (Week 6\)

- Record a demo of the full flow: request, approval, issuance, auto-renewal, and AI policy creation.
- Document the architecture, cost per operation (Bedrock and Private CA costs add up quickly), limitations, and risks.
- Write a go / no-go recommendation with a roadmap for the production build.

## Cost tips

AWS Private CA has a notable monthly fee per CA, so delete it when not demoing. Set AWS Budgets alerts and use small Bedrock models while iterating.

&nbsp;

---

gdoc_comments:
c1:
status: ACTIVE
token: AX5pRSmczKBN_jKLX3XpLJtcm_qufOGmrd9r-6itASEAOiASEN0H2ANis2xPzIT8rkcDlW_KI7_qjLqFSV6g0f-01OqStehmSlZ69d1A1V5MZVUOv9U01e5QDWGQJgPz6hxuaGl4yVRIgJHVZ0F9cs6AOxr3ShSMSBhjf6ZFq7ESwnNx8SzIOatThdfHd1L2IMl_NPhD1UCZTiw6Hh3kjsxCBYCOlmFHJxIuXOZPL01eQfG6dJyiYL2QAdfjYMj5mROtciaYid4H0JFX-qdSNMdx5eSZKhbDatiMRf0B_xh2iUIbNu6AABqdR3JzjK6gUYOvQvfJj-ljKe2jJ_6XMUyP4RYmOrqJ4vWIX_d2353NBx3pETE6F5yQo2tFPPt_DXzwqH7_vneviAfzF6YQQZCHDTxgoUAd2yw2nAsq_xq4qKqcjCyFHHZxOI1YPzKev6Reb2_sXS8poN4NHOY84bIUHj18WihxpFJG0XwFEv8-YHfgh6Xp5JiqbuRBNfGcWWlPq2Uh6y9mss30RS2o8K3rJIxM5VIZWJxSXW_lfoWTJtkpAYD_3tOktBclP5sDbtcMbs3FFXzujXv-cWz5HAjU6gIkUAETZo0XCzQ26_nn4IDnorDbBh546IRoJfpzkuwRVHLkfczv2vEDxkYRv2pZeUVTnSLqto3BrA43x2PWgDZNRMWkfPG2zfpR2OnAkDOLV1bcEREepc8s3Rj-Df-7rz_rL5dRBtMkPYn7l5dVOLC4Zw
head:
author: dan krumkop
time: '2026-11-04T07:17:13.993Z'
body: זה ה-README, אל תעשו.
quote: |- 1. Define scope and success criteria (Week 1)
Hypothesis: AI can safely automate certificate and secret management tasks that are normally manual.
In scope: certificate issuance and renewal, role-based access control, one policy enforced by AI, an audit trail.
Out of scope (for now): multi-tenant billing, full UI, every integration, HA and DR.
Success metrics: e.g. certificate issued in under 1 minute, 100% of actions logged, AI correctly translates 9 of 10 test policies, zero unauthorized access in tests.
c2:
status: ACTIVE
token: AX5pRSmnJdSC7ujOoVa3RbKJMPiQ7JOP5hc0yMhPdRHJBP3LdpMlmLmSmVy3-AO7pttwYL3YXt35fem8QWfQwcikmtYVwmr_zHeHeaW2QnjkD788zZMxbpVdDaTOHwEFTGHGnxD2H-nra-1UPupZNVMCkBukNf2sBVVa7QgsCvbsf436trjXDkGwSKal_KriNpvbHeZMQp2vMGCYCcWYZjBwGQjk0Bgd9ZJBTemgtWhlZl3EEnxjjTXDSM3Dxc6Ho0GebE1WAY0bkva_eakSPI1nWrPqwY-IjOj_KAGi8x3UftGATqJewrhb0Q08EwZBJqh3TYjqE-K1pSZXdj6zm3BEe5tKZuYIggXWVYOgK1rkM-lpBca1WYsGLI7VoZA
head:
author: dan krumkop
time: '2026-11-04T07:13:45.501Z'
body: עדיפות נמוכה - אל תעשו בינתיים.
quote: 6. Add keyring and password features (Week 3)
c3:
status: ACTIVE
token: AX5pRSl9Og0YOv08v4C7OzVvWPWDQJjSZMt8K3UthFfHrh4EbmOj8gOXw8auD6OdvCAOaUQYZ9FeQ_taPJ8eaIHawxrnOqxn7xFKPRnyvkc4wBmhLrQJ6kZOf-2Ha4ayIDVJLOZeEBdHHi2Xjdlo6vq0K9rO8gIQR06QsR92PF_1GKqskP8IpMZVDBL-vWpGLdP-_uDuW8XRFTExaNUwHmbOav10mcQOP3LglIlL0aE-pGSOiAoGLyTvLWtXxLE9qvQeohyZb6mJ3G3NQzuJFEJBr79BZmuwsNqmNRgFYGvlEIKVJ2Uoc0mbORaPVt0eWFfZSwglZzgTm6GE1PMwY3WFrZjGd8gItNkEWmt3oCvfk7eEDJh2nb2Vjf8
head:
author: dan krumkop
time: '2026-11-04T07:15:50.923Z'
body: תעשו vibe coding, גם זו עדיפות נמוכה בינתיים.
quote: 7. Add the AI layer (Week 3-4)
c4:
status: ACTIVE
token: AX5pRSn-uRBqELIM7d2n2DqGCsrWM5Wozgz8aK58lKGM8Vq-5TsvesIdJ38lZJoVYLQ9WSgPw7QkQM6vohDGkwa8FZM8ZT8R1v3POxnCpHfUbAVe8BhJ_Zq2SPyt69G-5kqlh-VKcIMG7V-yhTJPOVNLA0zeKOwcJ4pB6kZaEZwdu9UURQ-Ku95wUisKh-Fm6SYJsDZ6rrHRKXtksuhOHfPvYg0lztzTbxWTthh1eIH6WiIn6s74Sgy_rRpv7rFOTCw53s7UmpEH6uQO86D4VqrgrkuBYrlXH_So0MRCn8SSumu6DagfPlVe5nhoReNPA6AeQIED2_M49IvB_gtPz_M1NddktNSpbKkjDWk-NzkU0DPqNkWiIJflMSLq8gVm1x2fSwHLOXAWfIwPFAsMGF4MUP0x5mn5xQCXQlYVGnDo3VenPOWoAm78Jb-i8B1ITteJ5K2PWOoptsIdqDs2bRJoD4c5X93vS6P-CkYS5R4aLgr5JMIkE1DiPJJeHNHQwjVoLwNQxNa26tfE
head:
author: dan krumkop
time: '2026-11-04T07:16:36.101Z'
body: אל תעשו
quote: |- 10. Test and validate (Week 5)
Functional tests for each flow.
Security tests: attempt privilege escalation, prompt injection against the AI features, and access to another team&#39;s resources.
Measure against your success metrics from step 1.
---
