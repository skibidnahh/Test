import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const hitCounts = new Map();

// ==========================================
// 1. Hệ thống AI chính (đi lại, ngủ, tìm giường, và hút đồ vật)
// ==========================================
system.runInterval(() => {
    const time = world.getTimeOfDay();
    const isNight = (time > 13000 && time < 23500); 

    const overworld = world.getDimension("overworld");
    const penguins = overworld.getEntities({ type: "custom:gugugaga_penguin" });
    const claimedBeds = new Set();

    for (const penguin of penguins) {
        const isForcedSleep = penguin.hasTag("is_forced_sleep");
        const isSitting = penguin.hasTag("is_sitting");
        const isSleepy = isNight || isForcedSleep;

        const loc = penguin.location;
        const dim = penguin.dimension;

        if (!isNight && isForcedSleep) {
            penguin.removeTag("is_forced_sleep");
        }

        const inventory = penguin.getComponent("minecraft:inventory");
        if (inventory && inventory.container) {
            const container = inventory.container;

            // 🌟 Hệ thống hút đồ: chỉ hút được khi "không đang thả đồ" (is_dropping)
            if (container.emptySlotsCount > 0 && !penguin.hasTag("is_dropping")) {
                try {
                    const droppedItems = dim.getEntities({ type: "minecraft:item", location: loc, maxDistance: 1.5 });
                    for (const itemEntity of droppedItems) {
                        const itemComp = itemEntity.getComponent("minecraft:item");
                        if (itemComp && itemComp.itemStack) {
                            const leftover = container.addItem(itemComp.itemStack);
                            itemEntity.remove();
                            dim.playSound("random.pop", loc, { volume: 0.8, pitch: 1.5 });
                            if (leftover) {
                                dim.spawnItem(leftover, loc);
                                break; 
                            }
                        }
                    }
                } catch(e) {}
            }

            // 🚨 Hệ thống cảnh báo túi đồ đầy
            if (container.emptySlotsCount === 0) {
                if (!penguin.hasTag("inv_full_alert")) {
                    penguin.addTag("inv_full_alert");
                    const players = dim.getPlayers({ location: loc, maxDistance: 15 });
                    for (const p of players) {
                        p.sendMessage("§c🚨 [Cảnh báo] Gugugaga: Chủ ơi! Túi của con đầy ứ hết rồi ạ! 🐧🎒");
                        p.playSound("note.bass", { volume: 1.0, pitch: 0.5 });
                    }
                }
            } else {
                penguin.removeTag("inv_full_alert");
            }

            // 📥 Hệ thống đổ đồ vào Hopper
            try {
                const blockUnder = dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y - 0.2), z: Math.floor(loc.z) });
                if (blockUnder && blockUnder.typeId === "minecraft:hopper") {
                    let droppedAny = false;
                    for (let i = 0; i < container.size; i++) {
                        const item = container.getItem(i);
                        if (item) {
                            dim.spawnItem(item, { x: loc.x, y: loc.y + 0.5, z: loc.z });
                            container.setItem(i, undefined);
                            droppedAny = true;
                        }
                    }
                    if (droppedAny) dim.playSound("random.pop", loc, { volume: 1.0 });
                }
            } catch(e) {}
        }

        // ----- Hệ thống tìm giường và đi ngủ -----
        if (isSleepy) {
            let foundBed = false;
            let onBed = false;
            let targetBed = null;

            const searchRadius = 16; 
            for (let x = -searchRadius; x <= searchRadius; x++) {
                for (let y = -3; y <= 3; y++) {
                    for (let z = -searchRadius; z <= searchRadius; z++) {
                        try {
                            const bedX = Math.floor(loc.x) + x; const bedY = Math.floor(loc.y) + y; const bedZ = Math.floor(loc.z) + z;
                            const bedKey = `${bedX},${bedY},${bedZ}`;
                            const block = dim.getBlock({ x: bedX, y: bedY, z: bedZ });
                            if (block && block.typeId.includes("bed")) {
                                if (claimedBeds.has(bedKey)) continue;
                                foundBed = true; 
                                if (Math.abs(x) <= 3 && Math.abs(y) <= 3 && Math.abs(z) <= 3) {
                                    onBed = true;
                                    let bedRotY = penguin.getRotation().y; 
                                    try {
                                        const bedDir = block.permutation.getState("direction");
                                        if (bedDir === 0) bedRotY = 0; else if (bedDir === 1) bedRotY = 90; else if (bedDir === 2) bedRotY = 180; else if (bedDir === 3) bedRotY = -90;
                                    } catch(e) {}
                                    targetBed = { x: bedX, y: bedY, z: bedZ, rotY: bedRotY };
                                    break; 
                                } else if (!targetBed) { targetBed = { x: bedX, y: bedY, z: bedZ }; }
                            }
                        } catch(e) {}
                    }
                    if (onBed) break;
                }
                if (onBed) break;
            }

            if (foundBed && targetBed) {
                const tx = targetBed.x; const ty = targetBed.y; const tz = targetBed.z;
                claimedBeds.add(`${tx},${ty},${tz}`); claimedBeds.add(`${tx+1},${ty},${tz}`); claimedBeds.add(`${tx-1},${ty},${tz}`); claimedBeds.add(`${tx},${ty},${tz+1}`); claimedBeds.add(`${tx},${ty},${tz-1}`);
            }

            if (onBed && targetBed) {
                if (!penguin.hasTag("state_sleep")) {
                    penguin.addTag("state_sleep"); penguin.removeTag("state_wake"); penguin.removeTag("state_finding_bed"); 
                    try { penguin.teleport({ x: targetBed.x + 0.5, y: targetBed.y + 0.15, z: targetBed.z + 0.5 }, { dimension: dim, rotation: { x: 0, y: targetBed.rotY } }); } catch(e) {}
                    penguin.triggerEvent("gugugaga:sleep_now");
                }
            } else if (foundBed) {
                if (!penguin.hasTag("state_finding_bed")) {
                    penguin.addTag("state_finding_bed"); penguin.removeTag("state_sleep"); penguin.removeTag("state_wake");
                    penguin.triggerEvent("gugugaga:move_to_bed");
                }
            } else {
                if (!penguin.hasTag("state_wake")) {
                    penguin.addTag("state_wake"); penguin.removeTag("state_sleep"); penguin.removeTag("state_finding_bed");
                    penguin.triggerEvent(isSitting ? "gugugaga:sit" : "gugugaga:follow");
                }
                if (Math.random() < 0.15) dim.playSound("mob.gugugaga.cry", loc, { volume: 1.0 });
            }
        } else {
            if (penguin.hasTag("state_sleep") || penguin.hasTag("state_wake") || penguin.hasTag("state_finding_bed")) {
                penguin.removeTag("state_sleep"); penguin.removeTag("state_wake"); penguin.removeTag("state_finding_bed");
                penguin.triggerEvent(isSitting ? "gugugaga:sit" : "gugugaga:follow");
            }
            if (Math.random() < 0.10) dim.playSound("mob.gugugaga.idle", loc, { volume: 1.0 });
        }
    }
}, 20);

// ==========================================
// 2. Hệ thống bị đánh / âm thanh đau đớn
// ==========================================
world.afterEvents.entityHurt.subscribe((event) => {
    const entity = event.hurtEntity;
    if (entity.typeId === "custom:gugugaga_penguin") {
        let hits = (hitCounts.get(entity.id) || 0) + 1;
        hitCounts.set(entity.id, hits);
        if (hits > 5) entity.dimension.playSound("mob.gugugaga.cry", entity.location, { volume: 1.0 });
        else entity.dimension.playSound("mob.gugugaga.hurt", entity.location, { volume: 1.0 });
    }
});

world.afterEvents.entityDie.subscribe((event) => {
    const entity = event.deadEntity;
    if (entity.typeId === "custom:gugugaga_penguin") {
        hitCounts.delete(entity.id);
        entity.dimension.playSound("mob.gugugaga.death", entity.location, { volume: 1.0 });
    }
});

// ==========================================
// 3. Quản lý UI (túi đồ / điều khiển)
// ==========================================
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    const player = event.player;
    const target = event.target;

    if (target.typeId === "custom:gugugaga_penguin") {
        const isSitting = target.hasTag("is_sitting");
        const item = event.itemStack;

        if (item && item.typeId === "minecraft:cookie") {

    const health = target.getComponent("minecraft:health");

    if (health) {

        const current = health.currentValue;
        const max = health.effectiveMax;

        if (current < max) {

            health.setCurrentValue(
                Math.min(current + 10, max)
            );

            player.sendMessage(
                `§a🍪 Gugugaga: Nom nom~ Ngon quá! Cảm ơn chủ nha! ❤️ ${Math.min(current + 10, max)}/${max}`
            );

        } else {

            player.sendMessage(
                "§e🐧 Gugugaga: Tớ no rồi nè chủ ơi~ Máu đầy rồi! ❤️"
            );
        }

        hitCounts.delete(target.id);
    }

    return;
}

        system.runTimeout(() => showMainUI(player, target, isSitting), 10);
    }
});

function showMainUI(player, target, isSitting) {
    try {
        const gui = new ActionFormData();
        gui.title("§lQuản lý Gugugaga");
        gui.body("Trạng thái: Sẵn sàng nhận lệnh ạ!\nVui lòng chọn lệnh:");
        gui.button("🏠 Bắt đi ngủ", "textures/items/bed_red");
        gui.button(isSitting ? "🏃 Cho đi theo chủ" : "🛑 Cho ngồi chờ ở đây", "textures/items/apple");
        gui.button("🎒 Mở túi đồ", "textures/ui/inventory_icon");
        gui.button("❌ Đóng cửa sổ");

        gui.show(player).then((response) => {
            if (response.canceled) return;
            switch (response.selection) {
                case 0:
                    target.addTag("is_forced_sleep"); 
                    player.sendMessage("§aGugugaga: Con buồn ngủ rồi ạ! Dẫn con đi tìm giường với nhé, đứng xa là con nhõng nhẽo đó! 🐧💤");
                    break;
                case 1:
                    if (isSitting) {
                        target.removeTag("is_sitting"); target.triggerEvent("gugugaga:follow"); 
                        player.sendMessage("§eGugugaga: Đang lạch bạch đi theo chủ rồi ạ! 🐧✨");
                    } else {
                        target.addTag("is_sitting"); target.triggerEvent("gugugaga:sit"); 
                        player.sendMessage("§eGugugaga: Ngồi chờ ngoan ở đây rồi ạ! 🐧💖");
                    }
                    break;
                case 2:
                    system.runTimeout(() => showInventoryUI(player, target, isSitting), 5); 
                    break;
            }
        });
    } catch (e) {}
}

function showInventoryUI(player, target, isSitting) {
    try {
        const inventory = target.getComponent("minecraft:inventory");
        if (!inventory || !inventory.container) return;
        const container = inventory.container;

        const gui = new ActionFormData();
        gui.title("🎒 Túi đồ của Gugugaga");
        gui.body(`Ô trống: ${container.emptySlotsCount} / ${container.size} ô`);

        let itemsList = [];
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (item) {
                itemsList.push({ index: i, item: item });
                let itemName = item.typeId.replace("minecraft:", "").toUpperCase();
                gui.button(`📦 ${itemName} (x${item.amount})`);
            }
        }

        gui.button("🛑 Nhả hết đồ xuống đất!");
        gui.button("🔙 Quay lại trang chính");

        gui.show(player).then((response) => {
            if (response.canceled) return;

            // 🌟 Trường hợp 1: Nhả từng món đồ
            if (response.selection < itemsList.length) {
                const selectedItemData = itemsList[response.selection];

                // Gắn tag ngăn hút đồ lại ngay
                target.addTag("is_dropping");

                target.dimension.spawnItem(selectedItemData.item, target.location);
                container.setItem(selectedItemData.index, undefined); 
                player.sendMessage(`§aGugugaga: Phù! Nhả đồ cho chủ rồi ạ! 🐧📦`);

                // Khóa miệng 5 giây (100 ticks) rồi mới cho hút đồ lại
                system.runTimeout(() => { target.removeTag("is_dropping"); }, 100);

                system.runTimeout(() => showInventoryUI(player, target, isSitting), 5);

            // 🌟 Trường hợp 2: Nhả hết đồ
            } else if (response.selection === itemsList.length) {
                let dropped = false;

                // Gắn tag ngăn hút đồ lại ngay
                target.addTag("is_dropping"); 

                for (let i = 0; i < container.size; i++) {
                    const item = container.getItem(i);
                    if (item) {
                        const dropLoc = {
                            x: target.location.x + (Math.random() - 0.5) * 1,
                            y: target.location.y + 0.5,
                            z: target.location.z + (Math.random() - 0.5) * 1
                        };
                        target.dimension.spawnItem(item, dropLoc);
                        container.setItem(i, undefined);
                        dropped = true;
                    }
                }

                if (dropped) {
                    player.sendMessage("§aGugugaga: Ọe~~ Nhả hết đồ ra rồi ạ, nhẹ bụng ghê! 🐧💨");
                    // Khóa miệng 5 giây
                    system.runTimeout(() => { target.removeTag("is_dropping"); }, 100);
                } else {
                    target.removeTag("is_dropping");
                    player.sendMessage("§eTúi trống rỗng rồi ạ, không có gì để nhả nữa đâu chủ ơi! 🐧✨");
                }

            } else {
                system.runTimeout(() => showMainUI(player, target, isSitting), 5);
            }
        });
    } catch (e) {}
}

// ==========================================
// Hiển thị máu trên đầu Gugugaga
// ==========================================
system.runInterval(() => {

    const overworld = world.getDimension("overworld");

    const penguins = overworld.getEntities({
        type: "custom:gugugaga_penguin"
    });

    for (const penguin of penguins) {

    try {

        const health = penguin.getComponent("minecraft:health");

        if (!health) continue;

        const current = Math.ceil(health.currentValue);
        const max = Math.ceil(health.effectiveMax);

        let job = "🐾 Thú cưng";

        if (penguin.hasTag("job_guard")) {
            job = "⚔️ Vệ sĩ";
        } else if (penguin.hasTag("job_miner")) {
            job = "⛏️ Thợ mỏ";
        } else if (penguin.hasTag("job_lumberjack")) {
            job = "🪓 Tiều phu";
        }

        penguin.nameTag =
`§b🐧 Gugugaga
§c❤ ${current}/${max}
§e${job}`;

    } catch (e) {
        // bỏ qua lỗi
    }

}

}, 20);