# Copyright (c) 2026 OpenNVR
# This file is part of OpenNVR.
#
# OpenNVR is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# OpenNVR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.

"""add camera fisheye

Adds an optional per-camera ``fisheye`` lens description to ``cameras``.

A 360° fisheye camera (e.g. an Illumivue IP5VD360) sends the raw lens circle;
its vendor client flattens it into panoramas and a draggable virtual PTZ
view. OpenNVR does the same in the browser on the GPU, and this column tells
it how: the mount (ceiling / wall / desk) and where the circle sits in the
frame. Display only, like ``display_aspect_ratio``.

Nullable, no default: existing rows keep NULL, which means "not a fisheye".

Revision ID: a7c3e9f1b2d4
Revises: e4b9c2d6f0a3
Create Date: 2026-10-09 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7c3e9f1b2d4"
down_revision: str | None = "e4b9c2d6f0a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "cameras",
        sa.Column(
            "fisheye",
            sa.JSON(),
            nullable=True,
            comment=(
                "Fisheye lens for browser-side dewarping: NULL (ordinary "
                "camera) or {mount, center_x, center_y, radius, fov}. "
                "Display only — never re-provisions a stream."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("cameras", "fisheye")
