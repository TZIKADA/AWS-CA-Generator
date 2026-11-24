variable "name" { type = string }
variable "domain" {
  type        = string
  description = "Sending domain, must be inside the given Route 53 zone."
}
variable "route53_zone_id" { type = string }

resource "aws_sesv2_email_identity" "this" {
  email_identity = var.domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name
  delivery_options { tls_policy = "REQUIRE" }
  reputation_options { reputation_metrics_enabled = true }
  sending_options { sending_enabled = true }
}

# NOTE: new SES accounts start in the sandbox. Request production access in the SES console before inviting real users.
output "identity_arn" { value = aws_sesv2_email_identity.this.arn }
output "configuration_set_name" { value = aws_sesv2_configuration_set.this.configuration_set_name }
