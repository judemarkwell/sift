"""DynamoDB storage (not wired up yet).

This documents the single-table design so the AWS move is a fill-in-the-
blanks job. Every key starts with the org, which is what gives tenant
isolation (and lets an IAM policy restrict a caller to its own org prefix).

Table: sift   PK (string)            SK (string)                     notes
-------------------------------------------------------------------------------------
conversation  ORG#<org>              CONV#<conv_id>                  GSI1: USER#<user> / <updated_at>
trace         ORG#<org>              TRACE#<created_at>#<trace_id>   GSI2: CONV#<conv_id> / <created_at>
vault         ORG#<org>              VAULT#<conv_id>                 encrypted with a KMS key per org
settings      ORG#<org>|USER#<user>  SETTINGS                        org policy / user preference
account       ORG#<org>              ACCOUNT                         plan, period, balances
ledger        ORG#<org>              LEDGER#<created_at>#<id>
member        USER#<user>            MEMBER                          workspace of a signed-in user;
                                                                     put with attribute_not_exists(PK)

Daily spend for the platform budget comes from a counter item
(PK=PLATFORM, SK=SPEND#<yyyy-mm-dd>) updated with an atomic ADD, rather
than scanning traces.

Large traces: DynamoDB items max out at 400 KB, so trace bodies over ~350 KB
go to S3 (s3://sift-traces/<org>/<trace_id>.json) with a pointer in the item.
"""

from __future__ import annotations


class DynamoDBStorage:
    """Implements app.storage.base.Storage against the table above.

    To finish: `pip install boto3`, create the table (see infra/), set
    SIFT_STORAGE=dynamodb and SIFT_DYNAMODB_TABLE, and implement each method
    with put_item / get_item / query on the keys documented above.
    """

    def __init__(self, table_name: str) -> None:
        raise NotImplementedError(
            "DynamoDB storage isn't implemented yet. Use SIFT_STORAGE=sqlite for now; "
            "the key design is documented in app/storage/dynamodb.py."
        )
