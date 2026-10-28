// Supply SDK headers via your compiler include path; see docs/emulator.md.
#include <stddef.h>
#include <stdbool.h>
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32; typedef unsigned long long u64;
typedef signed char s8; typedef short s16; typedef int s32; typedef long long s64;
typedef unsigned long uintptr_t_;
#include "sunxi_display2.h"
#define O(t,f) long off_##t##__##f = offsetof(struct t, f);
#define S(t) long size_##t = sizeof(struct t);
S(disp_layer_config) S(disp_layer_info) S(disp_fb_info) S(disp_layer_config2) S(disp_layer_info2) S(disp_fb_info2)
O(disp_layer_config, info) O(disp_layer_config, enable) O(disp_layer_config, channel) O(disp_layer_config, layer_id)
O(disp_layer_info, mode) O(disp_layer_info, zorder) O(disp_layer_info, alpha_mode) O(disp_layer_info, alpha_value)
O(disp_layer_info, screen_win) O(disp_layer_info, fb) O(disp_layer_info, color)
O(disp_fb_info, addr) O(disp_fb_info, size) O(disp_fb_info, align) O(disp_fb_info, format) O(disp_fb_info, color_space)
O(disp_fb_info, pre_multiply) O(disp_fb_info, crop) O(disp_fb_info, flags)
O(disp_layer_config2, info) O(disp_layer_config2, enable) O(disp_layer_config2, channel) O(disp_layer_config2, layer_id)
O(disp_layer_info2, mode) O(disp_layer_info2, zorder) O(disp_layer_info2, alpha_mode) O(disp_layer_info2, alpha_value)
O(disp_layer_info2, screen_win) O(disp_layer_info2, fb) O(disp_layer_info2, color)
O(disp_fb_info2, fd) O(disp_fb_info2, size) O(disp_fb_info2, align) O(disp_fb_info2, format) O(disp_fb_info2, crop)
O(disp_fb_info, trd_right_addr) O(disp_fb_info, scan) O(disp_layer_info, b_trd_out) O(disp_layer_info, out_trd_mode) O(disp_layer_info, id)
long size_enum_color_space = sizeof(enum disp_color_space); long size_enum_format = sizeof(enum disp_pixel_format);
