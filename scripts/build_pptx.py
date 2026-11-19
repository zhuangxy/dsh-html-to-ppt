#!/usr/bin/env python3
"""Assemble a 16:9 PowerPoint from rendered slide images (one image per slide).

Usage:
    python build_pptx.py --output out.pptx --width 13.333 --height 7.5 img1.png [img2.png ...]

Each image is placed edge-to-edge on its own 16:9 slide. The slide size is set
in inches; python-pptx converts to EMUs internally.
"""

import argparse

from pptx import Presentation
from pptx.util import Inches


def build(output, images, width_in, height_in):
    prs = Presentation()
    prs.slide_width = Inches(width_in)
    prs.slide_height = Inches(height_in)
    # Layout 6 is the "blank" layout on the default template.
    blank = prs.slide_layouts[6]
    for image in images:
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(image, Inches(0), Inches(0),
                                 Inches(width_in), Inches(height_in))
    prs.save(output)


def main():
    parser = argparse.ArgumentParser(description="Build a 16:9 PPT from images.")
    parser.add_argument("--output", required=True, help="Output .pptx path.")
    parser.add_argument("--width", type=float, default=13.333, help="Slide width in inches.")
    parser.add_argument("--height", type=float, default=7.5, help="Slide height in inches.")
    parser.add_argument("images", nargs="+", help="Image paths, one per slide.")
    args = parser.parse_args()
    build(args.output, args.images, args.width, args.height)
    print(f"wrote {args.output} with {len(args.images)} slide(s)")


if __name__ == "__main__":
    main()
